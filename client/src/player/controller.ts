import type { DeviceProfile } from '@modules/media-caps';
import { AppState, type NativeEventSubscription } from 'react-native';

import type { ApiClient } from '@/api/client';
import { toAppError, type ErrorParams } from '@/api/errors';
import { createEngine, type EngineKind, type PlayerEngine } from '@/player/engines';
import {
  mediaUrl,
  startPlayback,
  stopPlayback,
  switchPlayback,
  TICKS_PER_SECOND,
  waitForPlayback,
  type Playback,
  type PlaybackPreferences,
  type PlaybackSwitch,
} from '@/player/playback-api';
import { ProgressQueue } from '@/player/progress-queue';

export type ControllerPhase =
  'starting' | 'resume' | 'playing' | 'switching' | 'failed' | 'stopped';
export type AudioTrack = NonNullable<NonNullable<Playback['mediaInfo']>['audioTracks']>[number];
export type SubtitleTrack = NonNullable<
  NonNullable<Playback['mediaInfo']>['subtitleTracks']
>[number];
export type NoticeKind = 'stepDown' | 'switchFailed' | 'offline';
export type Notice = { kind: NoticeKind; params?: ErrorParams; id: number };
export type FailedState = { code: string; params?: ErrorParams; actions: string[] };

export type ControllerOptions = {
  client: ApiClient;
  accountId: string;
  serverUrl: string;
  profile: DeviceProfile;
  nativeEngine: EngineKind;
  workId: string;
  releaseId?: string;
  /** Seconds; `undefined` asks resume vs from the start when the server has a saved position. */
  startSeconds?: number;
  preferences?: PlaybackPreferences;
};

const MIN_RESUME_SECONDS = 30;

const HEARTBEAT_MS = 10_000;
const LOCAL_SUBTITLES = new Set(['embedded', 'webvtt']);

/** One playback on this device: server start flow, engine, switches, step-down and progress reporting. */
export class PlaybackController {
  phase: ControllerPhase = 'starting';
  playback: Playback | null = null;
  engine: PlayerEngine | null = null;
  /** Server states in order of appearance (stepper). */
  states: string[] = [];
  failure: FailedState | null = null;
  notice: Notice | null = null;
  paused = false;
  ended = false;
  pictureInPicture = false;
  private reportedAt = 0;
  preferences: PlaybackPreferences;
  private version = 0;
  private listeners = new Set<() => void>();
  private abort = new AbortController();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private engineOff: (() => void) | null = null;
  private appState: NativeEventSubscription | null = null;
  private stepDownRevision = -1;
  private noticeId = 0;
  private lastError = '';
  private resumeChoice: ((seconds: number) => void) | null = null;
  /** Saved position offered in the `resume` phase. */
  resumeSeconds = 0;
  readonly progress: ProgressQueue;

  constructor(readonly options: ControllerOptions) {
    this.preferences = { engine: 'auto', ...options.preferences };
    this.progress = new ProgressQueue(options.accountId, options.client);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  private changed(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  get closed(): boolean {
    return this.abort.signal.aborted;
  }

  get position(): number {
    return this.engine?.getSnapshot().position ?? 0;
  }

  get duration(): number {
    const engine = this.engine?.getSnapshot().duration ?? 0;
    const ticks = this.playback?.mediaInfo?.durationTicks ?? 0;
    return engine || ticks / TICKS_PER_SECOND;
  }

  async start(): Promise<void> {
    const { client, workId, releaseId, profile } = this.options;
    const startSeconds = this.options.startSeconds ?? 0;
    try {
      const created = await startPlayback(
        client,
        {
          workId,
          releaseId,
          startPositionTicks: startSeconds
            ? Math.round(startSeconds * TICKS_PER_SECOND)
            : undefined,
          device: profile,
          preferences: this.preferences,
        },
        this.abort.signal
      );
      const ready = await this.wait(created);
      if (!ready) return;
      const position = await this.askResume(ready, startSeconds);
      if (this.closed) return;
      await this.attach(ready, position);
      this.report('start');
      this.heartbeat = setInterval(() => this.report('progress'), HEARTBEAT_MS);
      this.appState = AppState.addEventListener('change', (state) => {
        if (state === 'active') return void this.progress.flush();
        this.report('progress');
        // Leaving the app while playing enters picture-in-picture, which keeps playing.
        if (state === 'background' && !(this.engine?.supportsPictureInPicture && !this.paused))
          this.setPaused(true);
      });
    } catch (error) {
      if (this.closed) return;
      const appError = toAppError(error);
      this.fail({ code: appError.code, params: appError.params, actions: ['retry'] });
    }
  }

  private askResume(ready: Playback, fallback: number): Promise<number> {
    const saved = (ready.resumePositionTicks ?? 0) / TICKS_PER_SECOND;
    const duration = (ready.mediaInfo?.durationTicks ?? 0) / TICKS_PER_SECOND;
    const ask =
      this.options.startSeconds === undefined &&
      saved >= MIN_RESUME_SECONDS &&
      (!duration || saved < duration - MIN_RESUME_SECONDS);
    if (!ask) return Promise.resolve(fallback);
    this.resumeSeconds = saved;
    this.phase = 'resume';
    this.changed();
    return new Promise((resolve) => {
      this.resumeChoice = resolve;
    });
  }

  chooseStart(resume: boolean): void {
    const choose = this.resumeChoice;
    this.resumeChoice = null;
    choose?.(resume ? this.resumeSeconds : 0);
  }

  /** Polls a start or switch until ready; a failure ends the playback with the server's actions. */
  private async wait(created: Playback, failPlayback = true): Promise<Playback | null> {
    const ready = await waitForPlayback(
      this.options.client,
      created,
      (update) => this.onPlayback(update),
      this.abort.signal
    );
    if (ready.state !== 'failed') return ready;
    if (!failPlayback) {
      this.lastError = ready.error?.code ?? 'playback_failed';
      return null;
    }
    this.fail({
      code: ready.error?.code ?? 'playback_failed',
      params: ready.error?.params ?? undefined,
      actions: ready.suggestedActions?.length ? ready.suggestedActions : ['retry'],
    });
    return null;
  }

  private fail(failure: FailedState): void {
    this.failure = failure;
    this.phase = 'failed';
    void this.engine?.shutdown?.();
    this.engine?.pause();
    this.changed();
  }

  private onPlayback(update: Playback): void {
    this.playback = update;
    if (update.state && this.states.at(-1) !== update.state)
      this.states = [...this.states, update.state];
    this.changed();
  }

  private engineFor(playback: Playback): EngineKind {
    return playback.engine === 'vlc' ? 'vlc' : this.options.nativeEngine;
  }

  private async attach(playback: Playback, position: number): Promise<void> {
    const kind = this.engineFor(playback);
    let engine = this.engine;
    if (!engine || engine.kind !== kind) {
      this.engineOff?.();
      const old = engine;
      await old?.shutdown?.();
      if (old) setTimeout(() => old.release(), 500);
      engine = createEngine(kind);
      this.engine = engine;
      this.engineOff = engine.subscribe((event) => {
        if (event.type === 'error') void this.stepDown(event.reason);
        else if (event.type === 'ended') this.onEnded();
        // JS timers stop while the activity is paused (picture-in-picture); time events keep coming.
        else if (event.type === 'time') {
          if (this.pictureInPicture && Date.now() - this.reportedAt >= HEARTBEAT_MS)
            this.report('progress');
        } else if (event.type === 'pip') {
          this.pictureInPicture = event.active;
          this.changed();
        } else if (
          event.type === 'state' ||
          event.type === 'tracks' ||
          event.type === 'firstFrame'
        ) {
          // A freshly loaded source may autoplay although the viewer paused before the switch.
          if (event.type === 'state' && event.state === 'playing' && this.paused)
            this.engine?.pause();
          this.changed();
        }
      });
    }
    this.playback = playback;
    this.phase = 'playing';
    this.ended = false;
    this.applyServerTracks(engine, playback);
    engine.load({
      uri: mediaUrl(this.options.serverUrl, playback.url ?? ''),
      kind: playback.method === 'direct' ? 'progressive' : 'hls',
      startPosition: position || undefined,
    });
    if (this.paused) engine.pause();
    else engine.play();
    this.changed();
  }

  private applyServerTracks(engine: PlayerEngine, playback: Playback): void {
    const info = playback.mediaInfo;
    const local = (info?.subtitleTracks ?? []).filter((track) =>
      LOCAL_SUBTITLES.has(track.deliveredAs ?? '')
    );
    const audio = info?.audioTracks?.find((track) => track.selected);
    const subtitle = local.find((track) => track.selected);
    const expectAudio = audio?.deliveredAs === 'original';
    const unsubscribe = engine.subscribe((event) => {
      if (event.type !== 'tracks' || this.playback !== playback) return;
      const { tracks } = event;
      if (tracks.subtitles.length < local.length) return;
      if (expectAudio && tracks.audio.length < (info?.audioTracks?.length ?? 0)) return;
      done();
      const audioId = expectAudio && audio ? this.localTrackId('audio', audio.index) : null;
      if (audioId !== null && !tracks.audio.find((track) => track.id === audioId)?.selected)
        engine.setAudioTrack(audioId);
      const subtitleId = subtitle ? this.localTrackId('subtitle', subtitle.index) : null;
      const selected = tracks.subtitles.find((track) => track.selected)?.id ?? null;
      if (subtitleId !== selected && (subtitleId !== null || local.length))
        engine.setSubtitleTrack(subtitleId);
    });
    const timer = setTimeout(() => done(), 15_000);
    const done = () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }

  private report(event: 'start' | 'progress' | 'stop', position = this.position): void {
    const playback = this.playback;
    if (!playback?.workId) return;
    const duration = this.duration;
    this.reportedAt = Date.now();
    void this.progress.report({
      event,
      workId: playback.workId,
      playbackId: playback.playbackId,
      positionTicks: Math.round(position * TICKS_PER_SECOND),
      durationTicks: duration ? Math.round(duration * TICKS_PER_SECOND) : null,
    });
  }

  private onEnded(): void {
    const { position, duration } = this.engine?.getSnapshot() ?? { position: 0, duration: 0 };
    // expo-video can report playToEnd while a new source loads.
    if (this.ended || !duration || position < duration - 3) return;
    this.ended = true;
    this.report('progress', this.duration);
    this.changed();
  }

  private showNotice(kind: NoticeKind, params?: ErrorParams): void {
    this.noticeId += 1;
    this.notice = { kind, params, id: this.noticeId };
    this.changed();
  }

  dismissNotice(): void {
    this.notice = null;
    this.changed();
  }

  /** Playback error on this device: continue with the next method of the server's ranking. */
  async stepDown(reason?: string): Promise<void> {
    const playback = this.playback;
    if (!playback?.playbackId || this.closed || this.phase === 'switching') return;
    if (this.stepDownRevision === playback.revision) return;
    this.stepDownRevision = playback.revision;
    const from = playback.method ?? '';
    const ok = await this.serverSwitch({ stepDown: true }, false);
    if (ok) {
      this.showNotice('stepDown', { from, to: this.playback?.method ?? '', reason: reason ?? '' });
    }
  }

  /** Switch on the server (new rendition/version/method) and resume at the current position. */
  async serverSwitch(body: PlaybackSwitch, notifyFailure = true): Promise<boolean> {
    const playback = this.playback;
    if (!playback?.playbackId || this.closed) return false;
    const position = this.position;
    const previousPreferences = this.preferences;
    if (body.preferences) this.preferences = body.preferences;
    this.phase = 'switching';
    this.states = [];
    this.changed();
    try {
      // Same release: keep the tracks, a client-side subtitle pick is unknown to the server.
      const audio = this.currentAudio();
      const tracks =
        body.releaseId || !playback.mediaInfo
          ? {}
          : {
              ...(audio === null ? {} : { audioStreamIndex: audio }),
              subtitleStreamIndex: this.currentSubtitle() ?? -1,
            };
      const switched = await switchPlayback(this.options.client, playback.playbackId, {
        ...tracks,
        ...body,
        positionTicks: Math.round(position * TICKS_PER_SECOND),
      });
      const ready = await this.wait(switched, !notifyFailure);
      if (!ready) {
        if (notifyFailure) await this.restore(playback, position, previousPreferences);
        return false;
      }
      await this.attach(ready, position);
      return true;
    } catch (error) {
      if (this.closed) return false;
      const appError = toAppError(error);
      if (!notifyFailure) {
        this.fail({ code: appError.code, params: appError.params, actions: ['retry'] });
        return false;
      }
      this.lastError = appError.code;
      await this.restore(playback, position, previousPreferences);
      return false;
    }
  }

  /** A refused user switch: go back to what played before and say why. */
  private async restore(
    previous: Playback,
    position: number,
    preferences: PlaybackPreferences
  ): Promise<void> {
    this.preferences = preferences;
    const code = this.lastError || 'playback_failed';
    try {
      // The server does not switch a failed playback, so start a new one with the previous choices.
      if (previous.playbackId)
        await stopPlayback(this.options.client, previous.playbackId).catch(() => undefined);
      const switched = await startPlayback(
        this.options.client,
        {
          workId: previous.workId ?? this.options.workId,
          releaseId: previous.version?.releaseId ?? undefined,
          audioStreamIndex: previous.mediaInfo?.audioTracks?.find((track) => track.selected)?.index,
          subtitleStreamIndex:
            previous.mediaInfo?.subtitleTracks?.find((track) => track.selected)?.index ?? -1,
          startPositionTicks: Math.round(position * TICKS_PER_SECOND),
          device: this.options.profile,
          preferences,
        },
        this.abort.signal
      );
      const ready = await this.wait(switched);
      if (!ready) return;
      await this.attach(ready, position);
      this.showNotice('switchFailed', { code });
    } catch (error) {
      if (this.closed) return;
      const appError = toAppError(error);
      this.fail({ code: appError.code, params: appError.params, actions: ['retry'] });
    }
  }

  /** Engine track that renders server track `index` locally, if the delivery allows it. */
  private localTrackId(kind: 'audio' | 'subtitle', index: number): string | null {
    const info = this.playback?.mediaInfo;
    const engine = this.engine;
    if (!info || !engine) return null;
    const tracks = engine.getSnapshot().tracks;
    if (kind === 'audio') {
      const list = info.audioTracks ?? [];
      const track = list.find((item) => item.index === index);
      if (track?.deliveredAs !== 'original') return null;
      return tracks.audio[list.indexOf(track)]?.id ?? null;
    }
    const list = (info.subtitleTracks ?? []).filter((item) =>
      LOCAL_SUBTITLES.has(item.deliveredAs ?? '')
    );
    const position = list.findIndex((item) => item.index === index);
    return position >= 0 ? (tracks.subtitles[position]?.id ?? null) : null;
  }

  /** Server audio index currently heard (engine selection for local tracks). */
  currentAudio(): number | null {
    const info = this.playback?.mediaInfo;
    const list = info?.audioTracks ?? [];
    const engineTracks = this.engine?.getSnapshot().tracks.audio ?? [];
    const local = list.every((track) => track.deliveredAs === 'original');
    if (local && engineTracks.length === list.length) {
      const at = engineTracks.findIndex((track) => track.selected);
      if (at >= 0) return list[at]?.index ?? null;
    }
    return list.find((track) => track.selected)?.index ?? null;
  }

  /** Server subtitle index currently shown, `null` = off. */
  currentSubtitle(): number | null {
    const list = this.playback?.mediaInfo?.subtitleTracks ?? [];
    const burned = list.find((track) => track.selected && track.deliveredAs === 'burnedIn');
    if (burned) return burned.index;
    const local = list.filter((track) => LOCAL_SUBTITLES.has(track.deliveredAs ?? ''));
    const engineTracks = this.engine?.getSnapshot().tracks.subtitles ?? [];
    const at = engineTracks.findIndex((track) => track.selected);
    if (engineTracks.length >= local.length && local.length) return local[at]?.index ?? null;
    return list.find((track) => track.selected)?.index ?? null;
  }

  async selectAudio(track: AudioTrack): Promise<void> {
    const local = this.localTrackId('audio', track.index);
    if (local !== null) {
      this.engine?.setAudioTrack(local);
      this.changed();
      return;
    }
    await this.serverSwitch({
      audioStreamIndex: track.index,
      subtitleStreamIndex: this.currentSubtitle() ?? -1,
    });
  }

  async selectSubtitle(track: SubtitleTrack | null): Promise<void> {
    const burnedIn = this.playback?.mediaInfo?.subtitleTracks?.some(
      (item) => item.selected && item.deliveredAs === 'burnedIn'
    );
    if (!track) {
      if (burnedIn) {
        await this.serverSwitch({ subtitleStreamIndex: -1 });
        return;
      }
      this.engine?.setSubtitleTrack(null);
      this.changed();
      return;
    }
    const local = this.localTrackId('subtitle', track.index);
    if (local !== null && !burnedIn) {
      this.engine?.setSubtitleTrack(local);
      this.changed();
      return;
    }
    await this.serverSwitch({ subtitleStreamIndex: track.index });
  }

  selectVersion(releaseId: string): Promise<boolean> {
    return this.serverSwitch({ releaseId });
  }

  /** `null` = original quality. */
  setQuality(maxHeight: number | null): Promise<boolean> {
    return this.serverSwitch({ preferences: { ...this.preferences, maxHeight } });
  }

  setEnginePreference(engine: 'auto' | 'native' | 'vlc'): Promise<boolean> {
    return this.serverSwitch({ preferences: { ...this.preferences, engine } });
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused) {
      this.engine?.pause();
      this.report('progress');
    } else this.engine?.play();
    this.changed();
  }

  togglePlay(): void {
    if (this.ended) return this.replay();
    this.setPaused(!this.paused);
  }

  replay(): void {
    this.ended = false;
    this.seekTo(0);
    this.paused = false;
    this.engine?.play();
    this.changed();
  }

  seekTo(target: number): void {
    const engine = this.engine;
    if (!engine) return;
    const duration = this.duration;
    const clamped = Math.max(0, duration ? Math.min(target, duration - 1) : target);
    engine.seek(clamped);
    this.changed();
  }

  seekBy(delta: number): void {
    this.seekTo(this.position + delta);
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    const position = this.ended ? this.duration : this.position;
    this.abort.abort();
    this.chooseStart(false);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.appState?.remove();
    this.engineOff?.();
    const { engine, playback } = this;
    if (engine && playback) this.report('stop', position);
    else if (playback?.playbackId)
      await stopPlayback(this.options.client, playback.playbackId).catch(() => undefined);
    await engine?.shutdown?.();
    this.phase = 'stopped';
    this.changed();
    if (engine) setTimeout(() => engine.release(), 500);
  }
}
