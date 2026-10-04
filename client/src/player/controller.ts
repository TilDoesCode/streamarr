import type { DeviceProfile } from '@modules/media-caps';
import { AppState, type NativeEventSubscription } from 'react-native';

import type { ApiClient } from '@/api/client';
import { toAppError, type ErrorParams } from '@/api/errors';
import { isSingleAudio, noteAudioTracks, rememberAudioLanguage } from '@/player/audio-preference';
import {
  engineTrackFor,
  renditionFor,
  renditionOfTrack,
  type AudioRendition,
} from '@/player/audio-renditions';
import {
  createEngine,
  type EngineKind,
  type EngineState,
  type PlayerEngine,
} from '@/player/engines';
import { START_TOLERANCE } from '@/player/engines/start-seek';
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
import { subtitleAfterAudio } from '@/player/forced-subtitle';
import { ProgressQueue } from '@/player/progress-queue';

export type ControllerPhase =
  'starting' | 'resume' | 'playing' | 'switching' | 'failed' | 'stopped';
export type AudioTrack = NonNullable<NonNullable<Playback['mediaInfo']>['audioTracks']>[number];
export type SubtitleTrack = NonNullable<
  NonNullable<Playback['mediaInfo']>['subtitleTracks']
>[number];
export type NoticeKind = 'stepDown' | 'switchFailed' | 'offline';
export type Notice = { kind: NoticeKind; params?: ErrorParams; id: number };
/** `status`: HTTP status of the failed request (0 = no answer), when the failure was an API call. */
export type FailedState = {
  code: string;
  params?: ErrorParams;
  status?: number;
  actions: string[];
};
/** One audio switch: in the session (rendition) or via `/switch`; `ms` until the new track plays on. */
export type AudioSwitchSample = {
  via: 'session' | 'server';
  from: number | null;
  to: number;
  positionBefore: number;
  positionAfter?: number;
  ms?: number;
  /** Why this switch failed / why it replaced a failed in-session switch. */
  error?: string;
  fallback?: string;
};
type PendingAudio = {
  sample: AudioSwitchSample;
  at: number;
  engineId: string | null;
  confirmed: boolean;
  settle: (ok: boolean) => void;
};

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
/** An in-session audio switch that has not played on by then falls back to `/switch`. */
export const AUDIO_SWITCH_TIMEOUT_MS = 8_000;
/** Audio switch measurements kept for diagnostics (newest last). */
export const AUDIO_SWITCH_SAMPLES = 20;
const LOCAL_SUBTITLES = new Set(['embedded', 'webvtt']);
/** How often a new source re-applies the server's track picks over the engine's own choice. */
const MAX_SERVER_TRACK_APPLIES = 3;
const STEADY_STATES = new Set<EngineState>(['playing', 'paused', 'buffering', 'ended']);

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
  private serverTracksOff: (() => void) | null = null;
  private appState: NativeEventSubscription | null = null;
  private stepDownRevision = -1;
  private lastGoodPosition = 0;
  /** Start position not yet reached: reports never go below it, so a failed start keeps the resume point. */
  private startFloor = 0;
  private noticeId = 0;
  private lastError = '';
  private lastErrorStatus: number | undefined;
  private resumeChoice: ((seconds: number) => void) | null = null;
  /** Saved position offered in the `resume` phase. */
  resumeSeconds = 0;
  readonly audioSwitches: AudioSwitchSample[] = [];
  private pendingAudio: PendingAudio | null = null;
  private lastAudioError: string | null = null;
  /** The subtitle selection an in-session audio switch ends with (kept, or the new language's forced track). */
  private keptSubtitle: { id: string | null; until: number } | null = null;
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

  /** Where a switch continues: a loading or failed engine may already report 0. */
  get resumePosition(): number {
    const snapshot = this.engine?.getSnapshot();
    if (!snapshot || this.startFloor) return this.lastGoodPosition;
    return STEADY_STATES.has(snapshot.state) ? snapshot.position : this.lastGoodPosition;
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
          preferences: this.requestPreferences(isSingleAudio(releaseId)),
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
      this.fail({
        code: appError.code,
        params: appError.params,
        status: appError.status,
        actions: ['retry'],
      });
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
      this.lastErrorStatus = undefined;
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
        if (event.type === 'error' && this.pendingAudio?.engineId)
          this.settleAudio(false, event.reason);
        else if (event.type === 'error') void this.stepDown(event.reason);
        else if (event.type === 'audioError') {
          if (this.pendingAudio?.engineId) this.settleAudio(false, event.code);
        } else if (event.type === 'ended') this.onEnded();
        // JS timers stop while the activity is paused (picture-in-picture); time events keep coming.
        else if (event.type === 'time') {
          if (this.startFloor && event.position >= this.startFloor - START_TOLERANCE)
            this.startFloor = 0;
          if (STEADY_STATES.has(this.engine?.getSnapshot().state ?? 'idle') && !this.startFloor)
            this.lastGoodPosition = event.position;
          this.audioPlaying(event.position);
          if (this.pictureInPicture && Date.now() - this.reportedAt >= HEARTBEAT_MS)
            this.report('progress');
        } else if (event.type === 'pip') {
          this.pictureInPicture = event.active;
          this.changed();
        } else if (event.type === 'userPlayback') {
          // Paused/resumed from the system controls: adopt it, so the next start of a source does not undo it.
          this.paused = event.paused;
          if (event.paused) this.report('progress');
          this.changed();
        } else if (
          event.type === 'state' ||
          event.type === 'tracks' ||
          event.type === 'firstFrame'
        ) {
          // A freshly loaded source may autoplay although the viewer paused before the switch.
          if (event.type === 'state' && event.state === 'playing' && this.paused)
            this.engine?.pause();
          if (event.type === 'tracks') {
            this.audioConfirmed(event.tracks.audio);
            this.holdSubtitle(event.tracks.subtitles);
          }
          this.changed();
        }
      });
    }
    this.playback = playback;
    noteAudioTracks(playback.version?.releaseId, playback.mediaInfo?.audioTracks?.length ?? 2);
    this.phase = 'playing';
    this.ended = false;
    this.lastGoodPosition = position;
    this.startFloor = position;
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
    this.keptSubtitle = null;
    const info = playback.mediaInfo;
    const local = (info?.subtitleTracks ?? []).filter((track) =>
      LOCAL_SUBTITLES.has(track.deliveredAs ?? '')
    );
    const audio = info?.audioTracks?.find((track) => track.selected);
    const subtitle = local.find((track) => track.selected);
    const rendition = audio ? renditionFor(playback, audio.index) : undefined;
    const expectAudio = audio?.deliveredAs === 'original' || !!rendition;
    const audioCount = rendition
      ? (playback.audioRenditions?.length ?? 0)
      : (info?.audioTracks?.length ?? 0);
    let subtitleId: string | null | undefined;
    let subtitleApplied = 0;
    let audioApplied = 0;
    // Safari, AVPlayer and ExoPlayer may still pick by system or audio language: re-apply until the viewer picks.
    const unsubscribe = engine.subscribe((event) => {
      if (event.type !== 'tracks' || this.playback !== playback) return;
      const { tracks } = event;
      if (subtitleId === undefined && tracks.subtitles.length >= local.length)
        subtitleId = subtitle ? this.localTrackId('subtitle', subtitle.index, tracks) : null;
      const shown = tracks.subtitles.find((track) => track.selected)?.id ?? null;
      if (
        subtitleId !== undefined &&
        subtitleId !== shown &&
        (subtitleId !== null || local.length) &&
        subtitleApplied < MAX_SERVER_TRACK_APPLIES
      ) {
        subtitleApplied += 1;
        engine.setSubtitleTrack(subtitleId);
      }
      if (expectAudio && tracks.audio.length < audioCount) return;
      const audioId = expectAudio && audio ? this.localTrackId('audio', audio.index, tracks) : null;
      if (audioId === null) return subtitleId !== undefined && !local.length ? done() : undefined;
      if (audioApplied >= MAX_SERVER_TRACK_APPLIES) return done();
      if (!tracks.audio.find((track) => track.id === audioId)?.selected) {
        audioApplied += 1;
        engine.setAudioTrack(audioId);
      }
    });
    this.serverTracksOff?.();
    const timer = setTimeout(() => done(), 15_000);
    const done = () => {
      unsubscribe();
      clearTimeout(timer);
      if (this.serverTracksOff === done) this.serverTracksOff = null;
    };
    this.serverTracksOff = done;
  }

  private report(event: 'start' | 'progress' | 'stop', position = this.position): void {
    const playback = this.playback;
    if (!playback?.workId) return;
    const duration = this.duration;
    this.reportedAt = Date.now();
    if (this.startFloor) position = Math.max(position, this.startFloor);
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
      this.showNotice('stepDown', {
        from,
        to: this.playback?.method ?? '',
        engine: this.playback?.engine === 'vlc' && playback.engine !== 'vlc' ? 'vlc' : '',
        reason: reason ?? '',
      });
    }
  }

  /** Switch on the server (new rendition/version/method) and resume at the current position. */
  async serverSwitch(body: PlaybackSwitch, notifyFailure = true): Promise<boolean> {
    const playback = this.playback;
    if (!playback?.playbackId || this.closed) return false;
    const position = this.resumePosition;
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
      const single = !body.releaseId && (playback.mediaInfo?.audioTracks?.length ?? 2) <= 1;
      const switched = await switchPlayback(this.options.client, playback.playbackId, {
        ...tracks,
        ...body,
        ...(body.preferences ? { preferences: this.requestPreferences(single) } : {}),
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
        this.fail({
          code: appError.code,
          params: appError.params,
          status: appError.status,
          actions: ['retry'],
        });
        return false;
      }
      this.lastError = appError.code;
      this.lastErrorStatus = appError.status;
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
          preferences: this.requestPreferences((previous.mediaInfo?.audioTracks?.length ?? 2) <= 1),
        },
        this.abort.signal
      );
      const ready = await this.wait(switched);
      if (!ready) return;
      await this.attach(ready, position);
      const status = this.lastErrorStatus;
      this.showNotice(
        'switchFailed',
        status === undefined ? { code } : { code, status: `${status}` }
      );
    } catch (error) {
      if (this.closed) return;
      const appError = toAppError(error);
      this.fail({
        code: appError.code,
        params: appError.params,
        status: appError.status,
        actions: ['retry'],
      });
    }
  }

  /** Engine track that renders server track `index` locally, if the delivery allows it. */
  private localTrackId(
    kind: 'audio' | 'subtitle',
    index: number,
    tracks = this.engine?.getSnapshot().tracks
  ): string | null {
    const info = this.playback?.mediaInfo;
    if (!info || !tracks) return null;
    if (kind === 'audio') {
      const list = info.audioTracks ?? [];
      const track = list.find((item) => item.index === index);
      const rendition = renditionFor(this.playback, index);
      if (rendition) {
        const renditions = this.playback?.audioRenditions ?? [];
        return engineTrackFor(rendition, renditions, tracks.audio)?.id ?? null;
      }
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
    const pending = this.pendingAudio;
    if (pending) return pending.sample.to;
    const renditions = this.playback?.inSessionAudioSwitch
      ? (this.playback.audioRenditions ?? [])
      : [];
    const heard = engineTracks.find((track) => track.selected);
    if (renditions.length && heard) {
      const rendition = renditionOfTrack(heard, renditions, engineTracks);
      if (rendition) return rendition.streamIndex;
    }
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

  /** The session rendition that delivers server audio track `index`, if any. */
  renditionOf(index: number): AudioRendition | undefined {
    return renditionFor(this.playback, index);
  }

  async selectAudio(track: AudioTrack): Promise<void> {
    if (this.pendingAudio || track.index === this.currentAudio()) return;
    this.serverTracksOff?.();
    const from = this.currentAudio();
    const local = this.localTrackId('audio', track.index);
    const subtitle = this.subtitleFor(track);
    // A subtitle that must change but cannot change in the engine (burned in, not delivered) needs `/switch`.
    const subtitleLocal =
      subtitle.index === null ? null : this.localTrackId('subtitle', subtitle.index);
    const inEngine =
      !subtitle.changes ||
      (!subtitle.burnedIn && (subtitle.index === null || subtitleLocal !== null));
    if (inEngine && local !== null && !renditionFor(this.playback, track.index)) {
      this.engine?.setAudioTrack(local);
      if (subtitle.changes) this.keepSubtitle(subtitleLocal);
      this.rememberAudio(track);
      this.changed();
      return;
    }
    let fallback: string | undefined;
    if (inEngine && renditionFor(this.playback, track.index)) {
      // No engine track for the rendition (not listed yet, or no match): straight to `/switch`.
      const result =
        local === null
          ? 'no_engine_track'
          : await this.switchAudio(
              'session',
              from,
              track.index,
              local,
              undefined,
              subtitle.changes ? subtitleLocal : undefined
            );
      if (result === true) return void this.rememberAudio(track);
      if (this.closed) return;
      fallback = result;
    }
    const switched = this.switchAudio('server', from, track.index, null, fallback);
    const ok = await this.serverSwitch({
      audioStreamIndex: track.index,
      subtitleStreamIndex: subtitle.index ?? -1,
    });
    if (!ok) this.settleAudio(false);
    else this.rememberAudio(track);
    await switched;
  }

  /** No remembered audio language for a single-audio release: there is nothing to choose. */
  private requestPreferences(singleAudio: boolean): PlaybackPreferences {
    return singleAudio ? { ...this.preferences, audioLanguage: undefined } : this.preferences;
  }

  /** Server subtitle after switching to `track`: a forced one follows the audio language (PLAN § 5, 18:40). */
  private subtitleFor(track: AudioTrack): {
    index: number | null;
    changes: boolean;
    burnedIn: boolean;
  } {
    const list = this.playback?.mediaInfo?.subtitleTracks ?? [];
    const current = this.currentSubtitle();
    const language = this.renditionOf(track.index)?.language ?? track.language;
    const index = subtitleAfterAudio(list, current, language, this.preferences.subtitleMode);
    const burnedIn = list.some((item) => item.selected && item.deliveredAs === 'burnedIn');
    return { index, changes: index !== current, burnedIn };
  }

  /** Engine subtitle `id` to show after an audio pick; AVPlayer's own automatic selection is overridden. */
  private keepSubtitle(id: string | null): void {
    this.keptSubtitle = { id, until: Date.now() + AUDIO_SWITCH_TIMEOUT_MS };
    this.engine?.setSubtitleTrack(id);
  }

  /** The rendition's BCP-47 language when there is one ("en" rather than the file's "eng"). */
  private rememberAudio(track: AudioTrack): void {
    const language = this.renditionOf(track.index)?.language ?? track.language;
    rememberAudioLanguage(this.options.accountId, language);
  }

  /** Starts measuring an audio switch; in the session it also asks the engine for track `engineId`. */
  private switchAudio(
    via: AudioSwitchSample['via'],
    from: number | null,
    to: number,
    engineId: string | null,
    fallback?: string,
    subtitleId?: string | null
  ): Promise<true | string> {
    const sample: AudioSwitchSample = {
      via,
      from,
      to,
      positionBefore: this.resumePosition,
      ...(fallback ? { fallback } : {}),
    };
    this.audioSwitches.push(sample);
    this.audioSwitches.splice(0, this.audioSwitches.length - AUDIO_SWITCH_SAMPLES);
    this.lastAudioError = null;
    return new Promise((resolve) => {
      // A server switch runs its own start flow; this guard only frees the switch lock.
      const timeout = AUDIO_SWITCH_TIMEOUT_MS * (engineId === null ? 4 : 1);
      const timer = setTimeout(() => this.settleAudio(false, 'audio_switch_timeout'), timeout);
      this.pendingAudio = {
        sample,
        at: Date.now(),
        engineId,
        confirmed: false,
        settle: (ok) => {
          clearTimeout(timer);
          resolve(ok ? true : (this.lastAudioError ?? 'audio_switch_failed'));
        },
      };
      if (engineId !== null) {
        const subtitles = this.engine?.getSnapshot().tracks.subtitles ?? [];
        const keep = subtitles.find((track) => track.selected)?.id ?? null;
        this.keptSubtitle = {
          id: subtitleId === undefined ? keep : subtitleId,
          until: Date.now() + AUDIO_SWITCH_TIMEOUT_MS,
        };
        this.engine?.setAudioTrack(engineId);
        if (subtitleId !== undefined && subtitleId !== keep)
          this.engine?.setSubtitleTrack(subtitleId);
      }
      this.changed();
    });
  }

  private settleAudio(ok: boolean, reason?: string): void {
    const pending = this.pendingAudio;
    if (!pending) return;
    this.pendingAudio = null;
    if (reason) this.lastAudioError = reason;
    if (!ok && reason) pending.sample.error = reason;
    pending.settle(ok);
    this.changed();
  }

  private audioConfirmed(tracks: readonly { id: string; selected: boolean }[]): void {
    const pending = this.pendingAudio;
    if (!pending?.engineId || pending.confirmed) return;
    pending.confirmed = tracks.find((track) => track.selected)?.id === pending.engineId;
    // Paused, the clock does not move: the engine's confirmation completes the switch.
    if (pending.confirmed && this.paused) this.completeAudio(this.position);
  }

  /** The new track plays on: the clock moved after the engine confirmed it (session) or the source started (server). */
  private audioPlaying(position: number): void {
    const pending = this.pendingAudio;
    if (!pending || this.engine?.getSnapshot().state !== 'playing') return;
    const ready = pending.engineId
      ? pending.confirmed
      : this.phase === 'playing' && !this.startFloor;
    if (ready) this.completeAudio(position);
  }

  private completeAudio(position: number): void {
    const pending = this.pendingAudio;
    if (!pending) return;
    pending.sample.ms = Date.now() - pending.at;
    pending.sample.positionAfter = position;
    this.settleAudio(true);
  }

  /** AVPlayer re-runs its automatic media selection on an audio pick and drops or adds subtitles: put ours in place. */
  private holdSubtitle(subtitles: readonly { id: string; selected: boolean }[]): void {
    const kept = this.keptSubtitle;
    if (!kept) return;
    if (Date.now() > kept.until) return void (this.keptSubtitle = null);
    const selected = subtitles.find((track) => track.selected)?.id ?? null;
    if (selected !== kept.id) this.engine?.setSubtitleTrack(kept.id);
  }

  async selectSubtitle(track: SubtitleTrack | null): Promise<void> {
    this.keptSubtitle = null;
    this.serverTracksOff?.();
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
    // Below the server's resume threshold at once: the completed playback starts a new viewing (B8).
    this.report('progress', 0);
    this.paused = false;
    this.engine?.play();
    this.changed();
  }

  seekTo(target: number): void {
    const engine = this.engine;
    if (!engine) return;
    const duration = this.duration;
    const clamped = Math.max(0, duration ? Math.min(target, duration - 1) : target);
    this.startFloor = 0;
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
    this.settleAudio(false);
    this.chooseStart(false);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.serverTracksOff?.();
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
