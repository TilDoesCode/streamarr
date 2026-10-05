import type { DeviceProfile } from '@modules/media-caps';
import NetInfo from '@react-native-community/netinfo';
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
import { clock } from '@/player/format';
import {
  getPlayback,
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
import { classify, type Classified, type ErrorCategory } from '@/player/recovery/classify';
import {
  HINT_ACTIONS,
  type HintAction,
  type HintKey,
  type HintParams,
} from '@/player/recovery/hints';
import {
  cardActions,
  Incident,
  INCIDENT_RESET_MS,
  nextStep,
  OFFLINE_BUDGET_MS,
  type Attempt,
  type Decision,
} from '@/player/recovery/ladder';

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
  category?: ErrorCategory;
  /** The recovery steps that ran before the card ("What was tried"). */
  tried?: Attempt[];
  /** A specific line under the card text, e.g. where the file ends. */
  hint?: StatusHint;
};
export type StatusHint = { key: HintKey; params?: HintParams };
/** What the status layer shows over the picture: spinner, one hint line and its actions. */
export type PlayerStatus = {
  spinner: boolean;
  hint: StatusHint | null;
  actions: readonly HintAction[];
};
/** Connectivity source (NetInfo unless a test passes its own). */
export type NetworkSource = { subscribe(listener: (online: boolean) => void): () => void };
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
  network?: NetworkSource;
};

const NETINFO: NetworkSource = {
  subscribe: (listener) =>
    NetInfo.addEventListener((state) => listener(state.isConnected !== false)),
};

const MIN_RESUME_SECONDS = 30;
/** A resume prompt open this long checks that the server still has the playback. */
export const RESUME_REVALIDATE_MS = 60_000;

const HEARTBEAT_MS = 10_000;
/** An in-session audio switch that has not played on by then falls back to `/switch`. */
export const AUDIO_SWITCH_TIMEOUT_MS = 8_000;
/** Audio switch measurements kept for diagnostics (newest last). */
export const AUDIO_SWITCH_SAMPLES = 20;
const LOCAL_SUBTITLES = new Set(['embedded', 'webvtt']);
/** How often a new source re-applies the server's track picks over the engine's own choice. */
const MAX_SERVER_TRACK_APPLIES = 3;
const STEADY_STATES = new Set<EngineState>(['playing', 'paused', 'buffering', 'ended']);
/** Status timeline (state-matrix § 2 c): spinner after 1 s of a stall, a hint after 4 s, the ladder after 15 s. */
export const SPINNER_MS = 1_000;
export const HINT_MS = 4_000;
export const STALL_LADDER_MS = 15_000;
/** No picture after `ready` this long: reload once, then the T7 ladder. */
export const START_BUDGET_MS = { progressive: 20_000, hls: 30_000 };
/** An engine `paused` the app did not ask for, held this long, is a pause by the system. */
export const SYSTEM_PAUSE_MS = 1_000;
/** An error this close to the end (two HLS segments) ends playback instead of recovering. */
const END_MARGIN_SECONDS = 12;
const QUALITY_STEPS = [2160, 1080, 720, 480];
/** A server start state longer than this explains itself (E02); repairing follows its own ETA. */
export const STATE_BUDGET_MS: Record<string, number> = {
  queued: 60_000,
  resolving: 60_000,
  fallback: 60_000,
  planning: 30_000,
  starting: 45_000,
};
type Recovery = {
  decision: Decision;
  failure: Classified;
  position: number;
  due: number;
  running: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  extra: FailureExtra;
};
type FailureExtra = {
  params?: ErrorParams;
  status?: number;
  retryAfter?: number;
  serverActions?: string[];
  hint?: StatusHint;
};

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
  /** The device has no network (NetInfo); playback keeps its engine and waits. */
  offline = false;
  private offlineSince = 0;
  /** The engine paused without the app asking (call, other audio, headphones, lock …). */
  systemPaused = false;
  /** The browser started muted or refused to start. */
  autoplay: 'muted' | 'blocked' | null = null;
  private incident: Incident | null = null;
  private recovery: Recovery | null = null;
  /** The current source showed a picture (first frame or a moving clock). */
  private pictured = false;
  private loadingSince = 0;
  private stallSince = 0;
  private seekAt = 0;
  private loadPosition = 0;
  private stallAfterSeek = false;
  private stateSince = 0;
  /** A recovery step is replacing the source: errors of the old one are noise. */
  private stepping = false;
  private systemPauseTimer: ReturnType<typeof setTimeout> | null = null;
  private statusTicker: ReturnType<typeof setInterval> | null = null;
  private networkOff: (() => void) | null = null;

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
    try {
      await this.begin();
    } catch (error) {
      if (this.closed) return;
      this.onApiFailure(error);
    }
  }

  private async begin(): Promise<void> {
    const { client, workId, releaseId, profile } = this.options;
    const startSeconds = this.options.startSeconds ?? 0;
    const created = await startPlayback(
      client,
      {
        workId,
        releaseId,
        startPositionTicks: startSeconds ? Math.round(startSeconds * TICKS_PER_SECOND) : undefined,
        device: profile,
        preferences: this.requestPreferences(isSingleAudio(releaseId)),
      },
      this.abort.signal
    );
    let ready = await this.wait(created);
    if (!ready) return;
    const asked = Date.now();
    const position = await this.askResume(ready, startSeconds);
    if (this.closed) return;
    // A prompt left open long enough for the server to end the idle playback starts anew at the choice (E17).
    if (Date.now() - asked >= RESUME_REVALIDATE_MS && !(await this.alive(ready))) {
      const again = await startPlayback(
        client,
        {
          workId,
          releaseId: ready.version?.releaseId ?? releaseId,
          startPositionTicks: Math.round(position * TICKS_PER_SECOND),
          device: profile,
          preferences: this.requestPreferences(isSingleAudio(releaseId)),
        },
        this.abort.signal
      );
      ready = await this.wait(again);
      if (!ready) return;
    }
    await this.attach(ready, position);
    this.beginSession();
  }

  private async alive(playback: Playback): Promise<boolean> {
    try {
      await getPlayback(this.options.client, playback.playbackId ?? '', this.abort.signal);
      return true;
    } catch (error) {
      const status = toAppError(error).status;
      return status !== 404 && status !== 410;
    }
  }

  /** Heartbeats, app state and connectivity, once per controller. */
  private beginSession(): void {
    this.report('start');
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => this.report('progress'), HEARTBEAT_MS);
    this.appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void this.progress.flush();
        return void this.revalidate();
      }
      this.report('progress');
      // Leaving the app while playing enters picture-in-picture, which keeps playing.
      if (state === 'background' && !(this.engine?.supportsPictureInPicture && !this.paused))
        this.setPaused(true);
    });
    this.networkOff = (this.options.network ?? NETINFO).subscribe((online) =>
      this.onNetwork(online)
    );
  }

  private onNetwork(online: boolean): void {
    if (online === !this.offline || this.closed) return;
    this.offline = !online;
    this.offlineSince = online ? 0 : Date.now();
    if (online) {
      const recovery = this.recovery;
      if (recovery && !recovery.running && recovery.due === Infinity) this.runRecovery(0);
      else if (this.phase === 'failed' && this.failure?.category === 'T1') void this.retry();
      void this.revalidate();
    }
    this.tickStatus();
    this.changed();
  }

  /** After a long background or an outage: a playback the server ended starts again at the position (A09, B24). */
  async revalidate(): Promise<void> {
    const id = this.playback?.playbackId;
    if (!id || !this.engine || this.phase !== 'playing' || this.recovery) return;
    try {
      await getPlayback(this.options.client, id, this.abort.signal);
    } catch (error) {
      const appError = toAppError(error);
      if (this.closed || this.playback?.playbackId !== id) return;
      if (appError.status === 404 || appError.status === 410)
        this.handleFailure(classify({ kind: 'api', code: appError.code, status: appError.status }));
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
    this.onFailedPlayback(ready);
    return null;
  }

  /** The server failed the playback: its source is gone, so the ladder can only start anew or give up. */
  private onFailedPlayback(failed: Playback): void {
    const code = failed.error?.code ?? 'playback_failed';
    this.handleFailure(classify({ kind: 'api', code }), {
      params: failed.error?.params ?? undefined,
      serverActions: failed.suggestedActions ?? undefined,
      detached: true,
    });
  }

  private fail(failure: FailedState): void {
    this.cancelRecovery();
    this.failure = failure;
    this.phase = 'failed';
    this.stopStatusTicker();
    void this.engine?.shutdown?.();
    this.engine?.pause();
    this.changed();
  }

  /** Every failure goes through here: classified, then the next ladder step of the running incident. */
  private handleFailure(
    failure: Classified,
    extra: FailureExtra & { detached?: boolean } = {}
  ): void {
    if (this.closed || this.phase === 'failed') return;
    if (this.recovery && !this.recovery.running) return;
    const now = Date.now();
    if (!this.incident || now - this.incident.lastAt > INCIDENT_RESET_MS)
      this.incident = new Incident(now);
    const attached = !!this.engine && !extra.detached;
    const decision = nextStep(this.incident, failure, {
      attached,
      online: !this.offline,
      retryAfter: extra.retryAfter,
      canLowerQuality: this.lowerHeight() !== null,
      params: extra.params,
      revision: this.playback?.revision ?? 0,
    });
    if (decision.step === 'W') return;
    if (decision.step === 'G') return this.giveUp(failure, extra);
    this.cancelRecovery();
    this.recovery = {
      decision,
      failure,
      position: this.resumePosition,
      due: now + decision.delayMs,
      running: false,
      timer: null,
      extra,
    };
    this.runRecovery(decision.delayMs);
    this.tickStatus();
    this.changed();
  }

  private giveUp(failure: Classified, extra: FailureExtra): void {
    this.fail({
      code: failure.code,
      params: extra.params,
      status: extra.status,
      category: failure.category,
      actions: cardActions(failure.category, failure.code, extra.serverActions),
      tried: this.incident?.attempts.slice(),
      hint: extra.hint,
    });
  }

  private onApiFailure(error: unknown): void {
    const appError = toAppError(error);
    this.handleFailure(
      classify({ kind: 'api', code: appError.code, status: appError.status || undefined }),
      { params: appError.params, status: appError.status, retryAfter: appError.retryAfter }
    );
  }

  private cancelRecovery(): void {
    if (this.recovery?.timer) clearTimeout(this.recovery.timer);
    this.recovery = null;
  }

  private runRecovery(delayMs: number): void {
    const recovery = this.recovery;
    if (!recovery) return;
    if (recovery.timer) clearTimeout(recovery.timer);
    recovery.timer = null;
    recovery.due = Date.now() + delayMs;
    if (delayMs === Infinity) return;
    if (delayMs > 0) recovery.timer = setTimeout(() => this.runRecovery(0), delayMs);
    else void this.executeStep(recovery);
  }

  /** "Try now" on a waiting hint. */
  recoverNow(): void {
    if (this.recovery && !this.recovery.running && !this.offline) this.runRecovery(0);
  }

  private async executeStep(recovery: Recovery): Promise<void> {
    if (this.recovery !== recovery || this.closed) return;
    recovery.running = true;
    const { step } = recovery.decision;
    this.incident?.record({
      step,
      category: recovery.failure.category,
      code: recovery.failure.code,
      position: recovery.position,
      at: Date.now(),
      revision: this.playback?.revision ?? 0,
    });
    this.changed();
    // A new start keeps the old source on screen until it attaches; its errors must not start another step.
    this.stepping = step === 'N';
    try {
      if (step === 'R' && this.playback) await this.attach(this.playback, recovery.position);
      else if (step === 'N') await this.newStart(recovery.position);
      else if (step === 'Q')
        await this.serverSwitch(
          { preferences: { ...this.preferences, maxHeight: this.lowerHeight() } },
          false
        );
      else if (step === 'S') await this.stepDown(recovery.failure.code);
    } catch (error) {
      this.stepping = false;
      if (this.closed) return;
      if (this.recovery === recovery) this.recovery = null;
      this.onApiFailure(error);
    }
    this.stepping = false;
    // A start-phase restart hands over to the stepper; a running source clears the hint at its first picture.
    if (this.recovery === recovery && (!this.engine || this.phase !== 'playing'))
      this.recovery = null;
    this.tickStatus();
    this.changed();
  }

  /** A new playback at the position with the same release, tracks and preferences (ladder step N). */
  private async newStart(position: number): Promise<void> {
    if (!this.engine) {
      this.states = [];
      this.phase = 'starting';
      this.changed();
      return this.begin();
    }
    const previous = this.playback;
    if (previous?.playbackId)
      await stopPlayback(this.options.client, previous.playbackId).catch(() => undefined);
    const audio = this.currentAudio();
    const created = await startPlayback(
      this.options.client,
      {
        workId: previous?.workId ?? this.options.workId,
        releaseId: previous?.version?.releaseId ?? this.options.releaseId,
        audioStreamIndex: audio ?? undefined,
        subtitleStreamIndex: this.currentSubtitle() ?? -1,
        startPositionTicks: Math.round(position * TICKS_PER_SECOND),
        device: this.options.profile,
        preferences: this.requestPreferences((previous?.mediaInfo?.audioTracks?.length ?? 2) <= 1),
      },
      this.abort.signal
    );
    // The old picture stays while the new playback prepares (no stepper).
    const ready = await waitForPlayback(
      this.options.client,
      created,
      () => undefined,
      this.abort.signal
    );
    if (this.closed) return;
    if (ready.state === 'failed') return this.onFailedPlayback(ready);
    await this.attach(ready, position);
    this.report('start');
  }

  /** Retry from the card: a new start at the last good position, without asking to resume (E09). */
  retry(): boolean {
    if (this.closed || this.phase !== 'failed' || !this.engine) return false;
    this.failure = null;
    this.phase = 'playing';
    this.incident = null;
    this.recovery = {
      decision: { step: 'N', delayMs: 0, hint: 'reloading' },
      failure: { category: 'T11', code: 'retry' },
      position: this.lastGoodPosition,
      due: Date.now(),
      running: false,
      timer: null,
      extra: {},
    };
    void this.executeStep(this.recovery);
    return true;
  }

  /** One quality step below what plays now, or null at the bottom (ladder step Q). */
  private lowerHeight(): number | null {
    const video = this.engine?.getSnapshot().tracks.video;
    const info = this.playback?.mediaInfo?.video;
    const current = Math.min(
      video?.height ?? info?.deliveredHeight ?? info?.height ?? 0,
      this.preferences.maxHeight ?? Infinity
    );
    return QUALITY_STEPS.find((height) => height < current) ?? null;
  }

  private onPlayback(update: Playback): void {
    this.playback = update;
    if (update.state && this.states.at(-1) !== update.state) {
      this.states = [...this.states, update.state];
      this.stateSince = Date.now();
      this.tickStatus();
    }
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
        else if (event.type === 'error') this.onEngineError(event.reason);
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
          if (!this.pictured && Math.abs(event.position - this.loadPosition) >= 0.5)
            this.onPicture();
          if (this.pictureInPicture && Date.now() - this.reportedAt >= HEARTBEAT_MS)
            this.report('progress');
        } else if (event.type === 'buffering') {
          if (event.buffering) this.startStall();
          else this.clearStall();
        } else if (event.type === 'autoplay') {
          this.autoplay = event.result;
          if (event.result === 'blocked') this.paused = true;
          this.changed();
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
          if (event.type === 'firstFrame') this.onPicture();
          if (event.type === 'state') this.onEngineState(event.state);
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
    this.pictured = false;
    this.loadingSince = Date.now();
    this.loadPosition = position;
    this.stallSince = 0;
    this.tickStatus();
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

  private report(event: 'start' | 'progress' | 'stop', position = this.resumePosition): void {
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
    if (this.ended || !duration) return;
    if (position >= duration - 3) return this.finish();
    // expo-video reports playToEnd while a new source loads; a source that played and stops short ended early.
    if (!this.pictured || this.startFloor || this.phase !== 'playing') return;
    this.handleFailure(
      { category: 'T8', code: 'end_of_stream' },
      {
        hint: {
          key: 'endedEarly',
          params: { time: clock(position), missing: clock(duration - position) },
        },
      }
    );
  }

  private finish(): void {
    this.ended = true;
    this.clearStall();
    this.report('progress', this.duration);
    this.changed();
  }

  private onEngineError(reason: string): void {
    const engine = this.engine;
    if (!engine || this.closed || this.stepping) return;
    if (this.phase === 'failed' || this.phase === 'switching') return;
    const { position, duration } = engine.getSnapshot();
    // A missing last segment or a short tail: the end is reached, not a failure (C13).
    if (this.pictured && duration && position >= duration - END_MARGIN_SECONDS)
      return this.finish();
    this.handleFailure(classify({ kind: 'engine', engine: engine.kind, reason }));
  }

  private onPicture(): void {
    if (this.pictured) return;
    this.pictured = true;
    this.loadingSince = 0;
    if (this.recovery?.running) this.recovery = null;
    this.tickStatus();
    this.changed();
  }

  private onEngineState(state: EngineState): void {
    if (state === 'buffering' || (state === 'loading' && this.pictured)) return this.startStall();
    if (state === 'playing') {
      this.clearStall();
      if (this.systemPaused) {
        // The system resumed on its own (end of a call).
        this.systemPaused = false;
        this.paused = false;
      } else if (this.paused) this.engine?.pause();
    } else if (state === 'paused') {
      this.clearStall();
      this.watchSystemPause();
    } else if (state === 'ended' || state === 'error') this.clearStall();
    this.changed();
  }

  /** A pause the app did not ask for (native engines; web reports `userPlayback`) is adopted after a moment. */
  private watchSystemPause(): void {
    const engine = this.engine;
    if (!engine || engine.kind === 'web' || this.paused || !this.pictured || this.ended) return;
    if (this.systemPauseTimer) clearTimeout(this.systemPauseTimer);
    this.systemPauseTimer = setTimeout(() => {
      this.systemPauseTimer = null;
      if (this.engine !== engine || engine.getSnapshot().state !== 'paused') return;
      if (this.paused || this.ended || this.recovery || this.phase !== 'playing') return;
      this.paused = true;
      this.systemPaused = true;
      this.report('progress');
      this.changed();
    }, SYSTEM_PAUSE_MS);
  }

  private startStall(): void {
    if (!this.pictured || this.stallSince) return;
    this.stallSince = Date.now();
    this.stallAfterSeek = this.stallSince - this.seekAt < 2 * SPINNER_MS;
    this.tickStatus();
    this.changed();
  }

  private clearStall(): void {
    if (!this.stallSince) return;
    this.stallSince = 0;
    this.tickStatus();
    this.changed();
  }

  private startBudget(): number {
    return this.playback?.method === 'direct' ? START_BUDGET_MS.progressive : START_BUDGET_MS.hls;
  }

  /** Runs once a second while something is loading, stalled or recovering: hint thresholds and ladder triggers. */
  private tickStatus(): void {
    const active =
      !this.closed &&
      this.phase !== 'failed' &&
      ((!!this.loadingSince && !this.pictured) ||
        !!this.stallSince ||
        !!this.recovery ||
        (this.phase === 'starting' && !!this.stateSince));
    if (!active) return this.stopStatusTicker();
    this.statusTicker ??= setInterval(() => this.statusTick(), 1_000);
  }

  private stopStatusTicker(): void {
    if (this.statusTicker) clearInterval(this.statusTicker);
    this.statusTicker = null;
  }

  private statusTick(): void {
    const now = Date.now();
    const calm = !this.recovery && !this.offline && !this.paused && this.phase === 'playing';
    if (
      calm &&
      this.loadingSince &&
      !this.pictured &&
      now - this.loadingSince >= this.startBudget()
    ) {
      this.loadingSince = 0;
      this.handleFailure({ category: 'T7', code: 'start_timeout' });
    } else if (calm && this.stallSince && now - this.stallSince >= STALL_LADDER_MS) {
      this.stallSince = 0;
      this.handleFailure({
        category: 'T5',
        code: this.stallAfterSeek ? 'seek_stalled' : 'playback_stalled',
      });
    } else if (
      this.offline &&
      this.recovery?.due === Infinity &&
      now - this.offlineSince >= OFFLINE_BUDGET_MS
    )
      this.giveUp(this.recovery.failure, this.recovery.extra);
    this.tickStatus();
    this.changed();
  }

  /** Spinner, hint and actions over the picture (state-matrix § 2 c). */
  get status(): PlayerStatus {
    const none: PlayerStatus = { spinner: false, hint: null, actions: [] };
    if (this.phase === 'failed' || this.phase === 'stopped' || this.phase === 'resume') return none;
    const now = Date.now();
    const show = (hint: StatusHint | null, spinner: boolean): PlayerStatus => ({
      spinner,
      hint,
      actions: hint ? HINT_ACTIONS[hint.key] : [],
    });
    const loading = !!this.loadingSince && !this.pictured;
    const recovery = this.recovery;
    if (this.offline) return show({ key: 'offline' }, loading || !!this.stallSince || !!recovery);
    if (recovery) {
      const params: HintParams = {
        ...recovery.extra.params,
        seconds: Math.max(0, Math.ceil((recovery.due - now) / 1000)),
        time: clock(recovery.position),
      };
      return show({ key: recovery.decision.hint ?? 'reloading', params }, true);
    }
    if (this.phase === 'starting') {
      const state = this.states.at(-1) ?? '';
      const budget = STATE_BUDGET_MS[state];
      const slow = !!budget && !!this.stateSince && now - this.stateSince >= budget;
      return show(slow ? { key: 'startSlow', params: { cause: 'preparing' } } : null, false);
    }
    if (this.phase !== 'playing') return none;
    if (this.systemPaused)
      return show({ key: 'pausedBySystem', params: { cause: 'outside' } }, false);
    if (this.autoplay === 'blocked') return show({ key: 'autoplayBlocked' }, false);
    if (loading) {
      const slow = now - this.loadingSince >= HINT_MS;
      return show(slow ? { key: 'startSlow', params: { cause: this.slowCause() } } : null, true);
    }
    if (this.stallSince && !this.paused) {
      const since = now - this.stallSince;
      const spinner = since >= SPINNER_MS || now - this.seekAt < 2 * SPINNER_MS;
      const key = this.playback?.method === 'transcode' ? 'serverSlow' : 'buffering';
      return show(since >= HINT_MS ? { key } : null, spinner);
    }
    if (this.autoplay === 'muted') return show({ key: 'mutedAutoplay' }, false);
    return none;
  }

  private slowCause(): string {
    const method = this.playback?.method;
    return method === 'transcode'
      ? 'converting'
      : method === 'remux'
        ? 'preparing'
        : 'slowConnection';
  }

  unmute(): void {
    this.engine?.setMuted?.(false);
    this.autoplay = null;
    this.changed();
  }

  /** The status hint's "Lower quality": one step below what plays now. */
  lowerQuality(): Promise<boolean> {
    return this.setQuality(this.lowerHeight() ?? 480);
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
        // A recovery step that could not switch: the old source is broken, so the ladder goes on.
        this.phase = 'playing';
        this.onApiFailure(error);
        return false;
      }
      this.lastError = appError.code;
      this.lastErrorStatus = appError.status;
      const category = classify({
        kind: 'api',
        code: appError.code,
        status: appError.status,
      }).category;
      // The request never changed the playback (no network, refused request): the old source plays on (B18, B20).
      if (category === 'T1' || category === 'T11' || category === 'T9') {
        this.preferences = previousPreferences;
        this.phase = 'playing';
        this.showNotice('switchFailed', {
          code: appError.code,
          ...(appError.status ? { status: `${appError.status}` } : {}),
        });
        return false;
      }
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
    if (!paused) {
      this.systemPaused = false;
      if (this.autoplay === 'blocked') this.autoplay = null;
    }
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
    this.seekAt = Date.now();
    engine.seek(clamped);
    this.changed();
  }

  seekBy(delta: number): void {
    this.seekTo(this.position + delta);
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    const position = this.ended ? this.duration : this.resumePosition;
    this.abort.abort();
    this.cancelRecovery();
    this.stopStatusTicker();
    this.networkOff?.();
    if (this.systemPauseTimer) clearTimeout(this.systemPauseTimer);
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
