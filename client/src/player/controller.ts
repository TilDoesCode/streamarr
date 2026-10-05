import type { DeviceProfile } from '@modules/media-caps';
import NetInfo from '@react-native-community/netinfo';
import { AppState, type NativeEventSubscription } from 'react-native';

import type { ApiClient } from '@/api/client';
import { toAppError, type AppError, type ErrorParams } from '@/api/errors';
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
  getPlayback,
  mediaUrl,
  type StartRequest,
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
import { HealthMonitor, HEALTH_TICK_MS } from '@/player/health/monitor';
import type { EngineHealth } from '@/player/health/types';
import { CLOCK_FROZEN_MS } from '@/player/health/watchdog';
import { ProgressQueue, type ProgressAnswer } from '@/player/progress-queue';
import { followServerTracks } from '@/player/server-tracks';
import { SubtitleRetry } from '@/player/subtitle-retry';
import { classify, type Classified, type ErrorCategory } from '@/player/recovery/classify';
import {
  EMPTY_END_MS,
  END_MARGIN_SECONDS,
  HINT_MS,
  INCIDENT_RESET_MS,
  LOAD_RETRY_RECENT_MS,
  RESUME_REVALIDATE_MS,
  SEEK_DEBOUNCE_MS,
  SETTLE_MS,
  SPINNER_MS,
  STALL_LADDER_MS,
  START_BUDGET_MS,
  SYSTEM_PAUSE_MS,
} from '@/player/recovery/budgets';
import { cardActions, type Attempt, type LadderStep } from '@/player/recovery/ladder';
import { nextVersion } from '@/player/recovery/other-version';
import {
  RecoveryRunner,
  STEP_TIMEOUT,
  type FailureExtra,
  type Recovery,
  type StatusHint,
  type StepTracks,
} from '@/player/recovery/runner';
import { AutoRetry } from '@/player/recovery/auto-retry';
import { shortFile, transportEnd } from '@/player/recovery/early-end';
import { isRepairing } from '@/player/recovery/repair';
import { startStuck, stallFailure, type LoadRetry } from '@/player/recovery/stall';
import { StepBudget } from '@/player/recovery/step-budget';
import { statusOf, type PlayerStatus } from '@/player/recovery/status';
import { effectiveMuted } from '@/player/test-muted';

export type ControllerPhase =
  'starting' | 'resume' | 'playing' | 'switching' | 'failed' | 'stopped';
export type AudioTrack = NonNullable<NonNullable<Playback['mediaInfo']>['audioTracks']>[number];
export type SubtitleTrack = NonNullable<
  NonNullable<Playback['mediaInfo']>['subtitleTracks']
>[number];
export type NoticeKind =
  | 'stepDown'
  | 'switchFailed'
  | 'offline'
  | 'otherVersion'
  | 'audioFallback'
  | 'subtitleFailed'
  | 'subtitleNotDeliverable'
  | 'audioRestarted';
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
export type { StatusHint } from '@/player/recovery/runner';
export type { PlayerStatus } from '@/player/recovery/status';
export {
  EMPTY_END_MS,
  HINT_MS,
  ONLINE_SETTLE_MS,
  RESUME_REVALIDATE_MS,
  SEEK_DEBOUNCE_MS,
  SETTLE_MS,
  SPINNER_MS,
  STALL_LADDER_MS,
  START_BUDGET_MS,
  STATE_BUDGET_MS,
  SUBTITLE_RETRY_MS,
  SYSTEM_PAUSE_MS,
} from '@/player/recovery/budgets';
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

const HEARTBEAT_MS = 10_000;
/** An in-session audio switch that has not played on by then falls back to `/switch`. */
export const AUDIO_SWITCH_TIMEOUT_MS = 8_000;
/** Audio switch measurements kept for diagnostics (newest last). */
export const AUDIO_SWITCH_SAMPLES = 20;
const LOCAL_SUBTITLES = new Set(['embedded', 'webvtt']);
const STEADY_STATES = new Set<EngineState>(['playing', 'paused', 'buffering', 'ended']);
const BROKEN_PICTURE = new Set(['picture_black', 'picture_frozen', 'video_stalled']);
const QUALITY_STEPS = [2160, 1080, 720, 480];
/** A step's own source work: where it resumes, the viewer's tracks, and its budget's abort signal. */
type StepContext = { position: number; tracks: StepTracks | null; signal: AbortSignal };

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
  /** Sound is off (the viewer, or the browser's muted autoplay). */
  muted = effectiveMuted(false);
  private blockedAt: number | null = null;
  /** Where and when the source ended early: another end there is the repeat (C32), elsewhere a cut stream. */
  private earlyEndAt: { position: number; at: number } | null = null;
  /** The engine is retrying a failed media request on its own (status of the last one). */
  private loadRetry: LoadRetry | null = null;
  /** The budget of a viewer's switch (or its restore): no server progress for a minute ends it (S9a P8). */
  private switchBudget: StepBudget | null = null;
  private pendingSeek: { target: number; timer: ReturnType<typeof setTimeout> } | null = null;
  private readonly subtitleRetry = new SubtitleRetry({
    current: () => this.currentSubtitle(),
    release: () => this.playback?.version?.releaseId ?? null,
    show: (index) => {
      const id = this.localTrackId('subtitle', index);
      if (id !== null) this.engine?.setSubtitleTrack(id);
      return id !== null;
    },
  });
  private readonly undeliverableNoted = new Set<number>();
  private readonly runner: RecoveryRunner;
  /** Where the viewer chose to start (resume prompt): a restart before the first picture keeps it. */
  private chosenStart: number | null = null;
  /** Releases the ladder's "other version" step already played or tried. */
  private readonly triedReleases = new Set<string>();
  private readonly autoRetry = new AutoRetry();
  /** The current source showed a picture (first frame or a moving clock). */
  private pictured = false;
  private loadingSince = 0;
  private stallSince = 0;
  /** Stops the polls of the first start when the card takes over (B16). */
  private startAbort: AbortController | null = null;
  private seekAt = 0;
  private loadPosition = 0;
  /** The last clock reading of this source: a picture is a clock that runs, never one jump (S9a START). */
  private lastClock: number | null = null;
  private liveSeekTried = false;
  private stallAfterSeek = false;
  private stallPosition = 0;
  private readonly monitor: HealthMonitor;
  private settleUntil = 0;
  /** A seek the clock has not passed yet. */
  private seekTarget: number | null = null;
  private stateSince = 0;
  private systemPauseTimer: ReturnType<typeof setTimeout> | null = null;
  private statusTicker: ReturnType<typeof setInterval> | null = null;
  private networkOff: (() => void) | null = null;

  constructor(readonly options: ControllerOptions) {
    this.preferences = { engine: 'auto', ...options.preferences };
    this.progress = new ProgressQueue(options.accountId, options.client);
    this.progress.onAnswer = (answer) => this.onProgressAnswer(answer);
    this.progress.onRefused = (error) => this.onSignedOut(error);
    this.runner = new RecoveryRunner({
      situation: () => ({
        attached: !!this.engine,
        online: !this.offline,
        canLowerQuality: this.lowerHeight() !== null,
        revision: this.playback?.revision ?? 0,
        audioFallback: !!this.playback?.audioFallback,
      }),
      resumePosition: () => this.resumePosition,
      tracks: () => this.viewerTracks(),
      run: (step, recovery, signal) => this.runStep(step, recovery, signal),
      stepError: (error) => this.failureOf(error),
      giveUp: (failure, extra, tried) => this.giveUp(failure, extra, tried),
      changed: () => {
        this.tickStatus();
        this.changed();
      },
    });
    this.monitor = new HealthMonitor({
      engine: () => this.engine,
      closed: () => this.closed,
      context: (health) => this.healthContext(health),
      stall: () => (this.nearEnd() ? this.finish() : this.startStall()),
      escalate: (verdict, resumeAt) =>
        this.nearEnd()
          ? this.finish()
          : this.runner.handle(classify({ kind: 'watchdog', verdict }), {
              // Frames below a start position never reached (a live window) are no place to resume (S9a D10).
              position: this.startFloor ? undefined : resumeAt,
            }),
      changed: () => this.changed(),
    });
    // Known from the first moment: an offline start waits for the network instead of failing (A24).
    this.networkOff = (options.network ?? NETINFO).subscribe((online) => this.onNetwork(online));
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
    // A debounced seek is where the viewer wants to be before the engine is told (D31).
    return this.pendingSeek?.target ?? this.engine?.getSnapshot().position ?? 0;
  }

  /** Where a switch continues: a loading or failed engine may already report 0. */
  get resumePosition(): number {
    const snapshot = this.engine?.getSnapshot();
    if (!snapshot || this.startFloor) return this.lastGoodPosition;
    if (!STEADY_STATES.has(snapshot.state)) return this.lastGoodPosition;
    // Time events stalled while the engine clock ran on (JS thread starved): trust the engine clock.
    const native = this.monitor.nativeClock;
    return native && Date.now() - native.at <= 2 * HEALTH_TICK_MS
      ? Math.max(snapshot.position, native.position)
      : snapshot.position;
  }

  get duration(): number {
    const engine = this.engine?.getSnapshot().duration ?? 0;
    const ticks = this.playback?.mediaInfo?.durationTicks ?? 0;
    // Safari calls a playlist without ENDLIST live (duration Infinity): the server's length is the title's (S9a D10).
    return Number.isFinite(engine) && engine > 0 ? engine : ticks / TICKS_PER_SECOND;
  }

  async start(): Promise<void> {
    const startAbort = new AbortController();
    this.startAbort = startAbort;
    const stop = () => startAbort.abort();
    this.abort.signal.addEventListener('abort', stop);
    try {
      await this.begin(undefined, undefined, startAbort.signal);
    } catch (error) {
      // Closed, or the card already said that the start got stuck (B16).
      if (this.closed || this.phase === 'failed') return;
      this.onApiFailure(error);
    } finally {
      this.abort.signal.removeEventListener('abort', stop);
      if (this.startAbort === startAbort) this.startAbort = null;
    }
  }

  /** The start flow; `resumeAt` skips the resume question (a restart before the first picture keeps the choice). */
  private async begin(
    resumeAt?: number,
    releaseId?: string,
    signal: AbortSignal = this.abort.signal
  ): Promise<void> {
    const startSeconds = resumeAt ?? this.options.startSeconds ?? 0;
    const created = await startPlayback(
      this.options.client,
      this.startRequest(startSeconds, null, releaseId ?? this.options.releaseId, null),
      signal
    );
    let ready = await this.wait(created, true, signal);
    if (!ready || this.phase === 'failed') return;
    const asked = Date.now();
    const position = resumeAt ?? (await this.askResume(ready, startSeconds));
    if (this.closed) return;
    this.chosenStart = position;
    // A prompt left open long enough for the server to end the idle playback starts anew at the choice (E17).
    if (Date.now() - asked >= RESUME_REVALIDATE_MS && !(await this.alive(ready))) {
      const again = await startPlayback(
        this.options.client,
        this.startRequest(position, null, ready.version?.releaseId ?? releaseId, ready),
        signal
      );
      ready = await this.wait(again, true, signal);
      if (!ready) return;
    }
    await this.attach(ready, position);
    this.beginSession();
  }

  /** The one start body: same work and release, the viewer's tracks, the position and the preferences. */
  private startRequest(
    position: number,
    tracks: StepTracks | null,
    releaseId: string | null | undefined,
    base: Playback | null = this.playback
  ): StartRequest {
    const single = base
      ? (base.mediaInfo?.audioTracks?.length ?? 2) <= 1
      : isSingleAudio(releaseId ?? undefined);
    return {
      workId: base?.workId ?? this.options.workId,
      releaseId: releaseId ?? undefined,
      ...(tracks
        ? {
            audioStreamIndex: tracks.audio ?? undefined,
            subtitleStreamIndex: tracks.subtitle ?? -1,
          }
        : {}),
      startPositionTicks: position ? Math.round(position * TICKS_PER_SECOND) : undefined,
      device: this.options.profile,
      preferences: this.requestPreferences(single),
    };
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

  /** Heartbeats and app state, once per controller. */
  private beginSession(): void {
    this.report('start');
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => this.report('progress'), HEARTBEAT_MS);
    this.appState = AppState.addEventListener('change', (state) => {
      // Time in the background never counts against a stall or start budget.
      this.restartClocks();
      if (state === 'active') {
        void this.progress.flush();
        return void this.revalidate();
      }
      this.report('progress');
      // Leaving the app while playing enters picture-in-picture, which keeps playing.
      if (state === 'background' && !(this.engine?.supportsPictureInPicture && !this.paused))
        this.setPaused(true);
    });
  }

  private onNetwork(online: boolean): void {
    if (online === !this.offline || this.closed) return;
    this.offline = !online;
    this.offlineSince = online ? 0 : Date.now();
    // An outage never counts against a stall or start budget: back online, the clocks start over (no step-down).
    this.restartClocks();
    this.autoRetry.cancel();
    if (online) {
      this.runner.online();
      if (this.phase === 'failed' && this.failure?.category === 'T1')
        this.autoRetry.schedule(
          () => !this.offline && this.phase === 'failed' && this.failure?.category === 'T1',
          () => this.retry(true)
        );
      void this.revalidate();
    }
    this.tickStatus();
    this.changed();
  }

  private restartClocks(): void {
    const now = Date.now();
    if (this.stallSince) this.stallSince = now;
    if (this.loadingSince) this.loadingSince = now;
    if (this.seekTarget !== null) this.seekAt = now;
    // A start state's budget starts over too: an outage while the server starts is not the server stuck (review B4).
    if (this.stateSince) this.stateSince = now;
  }

  /** After a long background or an outage: a playback the server ended starts again at the position (A09, B24). */
  async revalidate(): Promise<void> {
    const id = this.playback?.playbackId;
    if (!id || !this.engine || this.phase !== 'playing' || this.runner.current) return;
    try {
      await getPlayback(this.options.client, id, this.abort.signal);
    } catch (error) {
      const appError = toAppError(error);
      if (this.closed || this.playback?.playbackId !== id) return;
      const failure = classify({ kind: 'api', code: appError.code, status: appError.status });
      // Gone on the server: start anew; signed out meanwhile: the card with Sign in (A03).
      if (appError.status === 404 || appError.status === 410 || failure.category === 'T3')
        this.runner.handle(failure, { params: appError.params, status: appError.status });
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
  private async wait(
    created: Playback,
    failPlayback = true,
    signal: AbortSignal = this.abort.signal
  ): Promise<Playback | null> {
    const ready = await waitForPlayback(
      this.options.client,
      created,
      (update) => this.onPlayback(update),
      signal
    );
    if (ready.state !== 'failed') return ready;
    if (!failPlayback) {
      this.lastError = ready.error?.code ?? 'playback_failed';
      this.lastErrorStatus = undefined;
      return null;
    }
    // A step's switch that failed must not leave the phase on "switching" (the viewer's own picks would be refused).
    if (this.phase === 'switching') this.phase = this.engine ? 'playing' : 'starting';
    this.onFailedPlayback(ready);
    return null;
  }

  /** The server failed the playback: its source is gone, so the ladder can only start anew or give up. */
  private onFailedPlayback(failed: Playback): void {
    const code = failed.error?.code ?? 'playback_failed';
    this.runner.handle(classify({ kind: 'api', code }), {
      params: failed.error?.params ?? undefined,
      serverActions: failed.suggestedActions ?? undefined,
      detached: true,
    });
  }

  private fail(failure: FailedState): void {
    this.runner.cancel();
    // The player never shows the generic "something went wrong": a client exception has its own text.
    this.failure =
      failure.code === 'unknown' ? { ...failure, code: 'player_internal_error' } : failure;
    this.phase = 'failed';
    // The card cannot show in picture-in-picture: back to the app's window, where it waits (A17).
    if (this.pictureInPicture) this.engine?.stopPictureInPicture?.();
    this.stopStatusTicker();
    this.monitor.stop();
    void this.engine?.shutdown?.();
    this.engine?.pause();
    this.changed();
  }

  private giveUp(failure: Classified, extra: FailureExtra, tried: Attempt[]): void {
    this.fail({
      code: failure.code,
      params: extra.params,
      status: extra.status,
      category: failure.category,
      actions: cardActions(failure.category, failure.code, extra.serverActions),
      tried,
      hint: extra.hint,
    });
  }

  /** Any thrown error as a ladder failure; client exceptions get their own code, never "unknown". */
  private failureOf(error: unknown): { failure: Classified; extra: FailureExtra } {
    if (this.phase === 'switching') this.phase = this.engine ? 'playing' : 'starting';
    if (error === STEP_TIMEOUT)
      return { failure: { category: 'T6', code: 'step_timeout' }, extra: {} };
    const appError = toAppError(error);
    // A 200 that is not JSON: a sign-in page or proxy answered instead of the server (A26).
    if (appError.code === 'server_error' && appError.cause instanceof SyntaxError)
      return { failure: { category: 'T1', code: 'network_intercepted' }, extra: {} };
    if (appError.code === 'unknown') {
      const detail = error instanceof Error ? error.message : String(error);
      return { failure: { category: 'T11', code: 'player_internal_error', detail }, extra: {} };
    }
    return {
      failure: classify({ kind: 'api', code: appError.code, status: appError.status || undefined }),
      extra: { params: appError.params, status: appError.status, retryAfter: appError.retryAfter },
    };
  }

  private onApiFailure(error: unknown): void {
    const { failure, extra } = this.failureOf(error);
    this.runner.handle(failure, extra);
  }

  /** "Try now" on a waiting hint. */
  recoverNow(): void {
    if (!this.offline) this.runner.runNow();
  }

  /** The viewer's audio and subtitle right now (server indexes), kept through every recovery step. */
  private viewerTracks(): StepTracks {
    return { audio: this.currentAudio(), subtitle: this.currentSubtitle() };
  }

  /** One ladder step; false when it changed nothing. */
  private async runStep(
    step: LadderStep,
    recovery: Recovery,
    signal: AbortSignal
  ): Promise<boolean> {
    const context: StepContext = { position: recovery.position, tracks: recovery.tracks, signal };
    if (step === 'R') {
      if (!this.playback || !this.engine) return false;
      await this.attach(this.playback, recovery.position, recovery.tracks);
      return true;
    }
    if (step === 'N') {
      // After a failed other-version start, its release is the one to start (review B5).
      await this.newStart(context, recovery.releaseId);
      return true;
    }
    if (step === 'Q') {
      const maxHeight = this.lowerHeight();
      if (maxHeight === null || !this.playback?.playbackId) return false;
      await this.serverSwitch({ preferences: { ...this.preferences, maxHeight } }, context);
      return true;
    }
    if (step === 'S') return this.stepDown(recovery.failure.code, context);
    if (step === 'A') return this.audioFallback(context);
    if (step === 'V') return this.otherVersion(context);
    return false;
  }

  /** Ladder step A: the server converts the audio to AAC stereo for the rest of the playback (B13). */
  private async audioFallback(context: StepContext): Promise<boolean> {
    if (!this.playback?.playbackId || this.playback.audioFallback) return false;
    const ok = await this.serverSwitch({ audioFallback: true }, context);
    if (ok) this.showNotice('audioFallback');
    return true;
  }

  /** The server lost the playback (idle expiry, restart, B13 `playbackAlive`): a silent new start at the position. */
  private onProgressAnswer({ report, playbackAlive }: ProgressAnswer): void {
    if (playbackAlive !== false || report.event === 'stop' || this.closed) return;
    const playback = this.playback;
    if (!playback?.playbackId || report.playbackId !== playback.playbackId) return;
    if (!this.engine || this.phase !== 'playing' || this.runner.current) return;
    this.runner.handle({ category: 'T2', code: 'playback_not_found' }, { quiet: true });
  }

  /** A heartbeat refused for good (session ended, password change): pause where it is and say so (A03, A05, A07). */
  private onSignedOut(error: AppError): void {
    if (this.closed || this.phase === 'failed') return;
    const failure = classify({ kind: 'api', code: error.code, status: error.status || undefined });
    if (failure.category !== 'T3') return;
    // The refused report stays queued for this account (24 h) and is sent once it signs in again.
    this.paused = true;
    this.engine?.pause();
    this.giveUp(failure, { params: error.params, status: error.status }, this.runner.attempts);
  }

  /** Subtitles failed to load or parse (C22, C23): off with a notice, one retry later; never a reason to stop. */
  private onSubtitleError(code: string): void {
    if (this.closed || this.phase !== 'playing') return;
    const failed = this.subtitleRetry.fail();
    if (!failed) return;
    // The server's pick must not be re-applied over the failed track right after a load.
    this.serverTracksOff?.();
    this.engine?.setSubtitleTrack(null);
    this.showNotice('subtitleFailed', {
      index: `${failed.index}`,
      code,
      retry: failed.retryLater ? 'later' : '',
    });
  }

  /** A selected subtitle the server cannot deliver to this device is said at once, with VLC when it could (C24). */
  private noteUndeliverable(playback: Playback): void {
    const track = playback.mediaInfo?.subtitleTracks?.find(
      (item) => item.selected && item.deliveredAs === 'none'
    );
    if (!track || this.undeliverableNoted.has(track.index)) return;
    this.undeliverableNoted.add(track.index);
    const vlc =
      playback.engine !== 'vlc' &&
      (this.options.profile.engines ?? []).some((engine) => engine.engine === 'vlc');
    this.showNotice('subtitleNotDeliverable', { index: `${track.index}`, vlc: vlc ? 'vlc' : '' });
  }

  /** Ladder step V: the best other version this device plays, at the same position. */
  private async otherVersion(context: StepContext): Promise<boolean> {
    if (this.options.releaseId) this.triedReleases.add(this.options.releaseId);
    const releaseId = await nextVersion(
      this.options.client,
      this.playback?.workId ?? this.options.workId,
      this.options.profile,
      this.triedReleases,
      context.signal
    );
    if (!releaseId || this.closed) return false;
    this.triedReleases.add(releaseId);
    this.runner.choose(releaseId);
    // Track indexes belong to a release: the new one picks by the viewer's language preferences.
    await this.newStart({ ...context, tracks: null }, releaseId);
    if (this.playback?.version?.releaseId === releaseId) this.showNotice('otherVersion');
    return true;
  }

  /** A new playback at the position with the same release, tracks and preferences (ladder step N, V). */
  private async newStart(context: StepContext, releaseId?: string): Promise<void> {
    const { position, tracks, signal } = context;
    if (!this.engine) {
      this.states = [];
      this.phase = 'starting';
      this.changed();
      return this.begin(this.chosenStart ?? undefined, releaseId, signal);
    }
    const previous = this.playback;
    if (previous?.playbackId)
      await stopPlayback(this.options.client, previous.playbackId).catch(() => undefined);
    const created = await startPlayback(
      this.options.client,
      this.startRequest(
        position,
        tracks,
        releaseId ?? previous?.version?.releaseId ?? this.options.releaseId
      ),
      signal
    );
    // The old picture stays while the new playback prepares (no stepper); each new server state extends the step's budget.
    let state = created.state;
    const progress = (update: Playback) => {
      if (update.state === state) return;
      state = update.state;
      this.runner.progress();
    };
    let ready = await waitForPlayback(this.options.client, created, progress, signal);
    if (this.closed || signal.aborted) return;
    if (ready.state === 'failed') return this.onFailedPlayback(ready);
    // The audio conversion is part of the viewing, not of one server playback: the new one converts too.
    if (previous?.audioFallback && !ready.audioFallback && ready.playbackId) {
      const converted = await switchPlayback(
        this.options.client,
        ready.playbackId,
        { audioFallback: true, positionTicks: Math.round(position * TICKS_PER_SECOND) },
        signal
      );
      this.runner.progress();
      ready = await waitForPlayback(this.options.client, converted, progress, signal);
      if (this.closed || signal.aborted) return;
      if (ready.state === 'failed') return this.onFailedPlayback(ready);
    }
    await this.attach(ready, position);
    this.report('start');
  }

  /** Retry from the card: a new start at the last good position without the resume question (E09); `auto` keeps the incident's budget. */
  retry(auto = false): boolean {
    if (this.closed || this.phase !== 'failed') return false;
    if (!auto) this.runner.reset();
    this.failure = null;
    this.phase = this.engine ? 'playing' : 'starting';
    this.runner.start('N', { category: 'T11', code: 'retry' }, this.lastGoodPosition);
    this.tickStatus();
    this.changed();
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
      if (this.phase === 'switching') this.switchBudget?.extend();
      this.states = [...this.states, update.state];
      this.stateSince = Date.now();
      this.tickStatus();
    }
    this.changed();
  }

  private engineFor(playback: Playback): EngineKind {
    return playback.engine === 'vlc' ? 'vlc' : this.options.nativeEngine;
  }

  /** Loads `playback` at `position`; `tracks` (a reload) puts the viewer's audio/subtitle back over the server's pick. */
  private async attach(
    playback: Playback,
    position: number,
    tracks: StepTracks | null = null
  ): Promise<void> {
    // The old picture stays under the switching card, unless it is the broken picture being replaced (review R5).
    const failed = this.runner.current?.failure.code ?? '';
    const keepLastFrame = this.phase === 'switching' && !BROKEN_PICTURE.has(failed);
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
        else if (event.type === 'error') this.onEngineError(event.reason, event.status);
        else if (event.type === 'subtitleError') this.onSubtitleError(event.code);
        else if (event.type === 'loadRetry') {
          this.loadRetry = { status: event.status ?? 0, audio: !!event.audio, at: Date.now() };
          this.changed();
        } else if (event.type === 'audioError') {
          if (this.pendingAudio?.engineId) this.settleAudio(false, event.code);
        } else if (event.type === 'ended') this.onEnded();
        // JS timers stop while the activity is paused (picture-in-picture); time events keep coming.
        else if (event.type === 'time') {
          if (this.startFloor && event.position >= this.startFloor - START_TOLERANCE)
            this.startFloor = 0;
          if (STEADY_STATES.has(this.engine?.getSnapshot().state ?? 'idle') && !this.startFloor)
            this.lastGoodPosition = event.position;
          this.autoplayResumed(event.position);
          this.audioPlaying(event.position);
          if (!this.pictured && this.clockRuns(event.position)) this.onPicture();
          this.keepLivePosition(event.position, event.duration);
          this.onClock(event.position);
          if (this.pictureInPicture && Date.now() - this.reportedAt >= HEARTBEAT_MS)
            this.report('progress');
        } else if (event.type === 'buffering') {
          if (event.buffering) this.startStall();
          else this.clearStall();
        } else if (event.type === 'autoplay') {
          this.autoplay = event.result;
          if (event.result === 'muted') this.muted = true;
          if (event.result === 'blocked') {
            this.paused = true;
            this.blockedAt = this.engine?.getSnapshot().position ?? 0;
          }
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
    this.noteUndeliverable(playback);
    // Every release that played counts as tried for the "other version" step.
    if (playback.version?.releaseId) this.triedReleases.add(playback.version.releaseId);
    noteAudioTracks(playback.version?.releaseId, playback.mediaInfo?.audioTracks?.length ?? 2);
    this.endSwitch();
    this.phase = 'playing';
    this.ended = false;
    this.lastGoodPosition = position;
    this.startFloor = position;
    this.pictured = false;
    this.loadingSince = Date.now();
    this.loadPosition = position;
    this.lastClock = null;
    this.liveSeekTried = false;
    this.stallSince = 0;
    this.seekTarget = null;
    this.monitor.newSource();
    this.settle();
    this.runner.attached();
    this.monitor.start();
    this.tickStatus();
    this.applyServerTracks(engine, playback, tracks);
    try {
      engine.load({
        uri: mediaUrl(this.options.serverUrl, playback.url ?? ''),
        kind: playback.method === 'direct' ? 'progressive' : 'hls',
        startPosition: position || undefined,
        keepLastFrame,
      });
    } catch (error) {
      // An engine that cannot take the source must not play the old one on (S9a E09): it stops, the card follows.
      engine.pause();
      void engine.shutdown?.();
      throw error;
    }
    if (this.paused) engine.pause();
    else engine.play();
    this.changed();
  }

  private applyServerTracks(
    engine: PlayerEngine,
    playback: Playback,
    viewer: StepTracks | null = null
  ): void {
    this.keptSubtitle = null;
    this.serverTracksOff?.();
    const done = followServerTracks(engine, playback, viewer, {
      localTrackId: (kind, index, tracks) => this.localTrackId(kind, index, tracks),
      current: () => this.playback === playback,
      ended: () => {
        if (this.serverTracksOff === done) this.serverTracksOff = null;
      },
    });
    this.serverTracksOff = done;
  }

  private report(event: 'start' | 'progress' | 'stop', position = this.resumePosition): void {
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
    if (this.ended || this.phase !== 'playing') return;
    // A file with no or under a second of media (C31): nothing to watch, so it is explained, never "ended".
    const blank =
      !this.pictured && !!this.loadingSince && Date.now() - this.loadingSince >= EMPTY_END_MS;
    if (this.loadPosition < 1 && ((duration > 0 && duration < 1) || blank))
      return this.runner.handle({ category: 'T8', code: 'empty_media' }, { position: 0 });
    if (!duration) return;
    if (position >= duration - 3) return this.finish();
    // A reloaded short file often ends again before any time event: its position is the one it was loaded at.
    const endAt = this.startFloor ? this.loadPosition : position;
    if (this.earlyEndAt && Date.now() - this.earlyEndAt.at > INCIDENT_RESET_MS)
      this.earlyEndAt = null;
    const first = this.earlyEndAt;
    if (first && this.phase === 'playing') return void this.earlyEnd(endAt, first.position);
    // expo-video reports playToEnd while a new source loads; a source that played and stops short ended early.
    if (!this.pictured || this.startFloor || this.phase !== 'playing') return;
    void this.earlyEnd(position);
  }

  /** An end before the duration: offline or cut elsewhere is transport, a gone playback restarts, else the file is short. */
  private async earlyEnd(endAt: number, firstEnd?: number): Promise<void> {
    const transport = transportEnd(this.offline, endAt, firstEnd);
    if (transport) return this.runner.handle(transport, { position: endAt });
    let confirmed = this.playback;
    const id = confirmed?.playbackId;
    if (id) {
      try {
        confirmed = await getPlayback(this.options.client, id, this.abort.signal);
      } catch (error) {
        const appError = toAppError(error);
        if (this.closed) return;
        if (appError.status === 404 || appError.status === 410)
          return this.runner.handle(
            classify({ kind: 'api', code: appError.code, status: appError.status }),
            { position: endAt }
          );
      }
    }
    if (this.closed || this.ended) return;
    const length = (confirmed?.mediaInfo?.durationTicks ?? 0) / TICKS_PER_SECOND || this.duration;
    const short = shortFile(endAt, length);
    if (!short) return this.finish();
    this.earlyEndAt = { position: endAt, at: Date.now() };
    this.runner.handle(short.failure, short.extra);
  }

  /** The last seconds of the title: a stall, a frozen clock or a picture/sound verdict there ends it (review B3). */
  private nearEnd(): boolean {
    const duration = this.duration;
    return this.pictured && duration > 0 && this.resumePosition >= duration - END_MARGIN_SECONDS;
  }

  private finish(): void {
    this.ended = true;
    this.clearStall();
    this.report('progress', this.duration);
    this.changed();
  }

  private onEngineError(reason: string, status?: number): void {
    const engine = this.engine;
    if (!engine || this.closed || this.runner.replacing) return;
    if (this.phase === 'failed' || this.phase === 'switching') return;
    // A failed engine may already report 0: the last good position says where it stopped.
    const { duration } = engine.getSnapshot();
    const position = this.resumePosition;
    // A missing last segment or a short tail: the end is reached, not a failure (C13).
    if (this.pictured && duration && position >= duration - END_MARGIN_SECONDS)
      return this.finish();
    this.runner.handle(classify({ kind: 'engine', engine: engine.kind, reason, status }));
  }

  /** An engine that plays a live window below the load position (Safari without ENDLIST): back to the position, once. */
  private keepLivePosition(position: number, duration: number): void {
    const floor = this.startFloor;
    if (!floor || !this.pictured || this.liveSeekTried || Number.isFinite(duration)) return;
    if (position >= floor - 3) return;
    this.liveSeekTried = true;
    this.engine?.seek(floor);
  }

  /** Two clock readings a little apart in forward order: frames are playing (hls.js reports 0:00 before its start seek). */
  private clockRuns(position: number): boolean {
    const previous = this.lastClock;
    this.lastClock = position;
    return previous !== null && position > previous && position - previous <= 3;
  }

  private onPicture(): void {
    if (this.pictured) return;
    this.pictured = true;
    this.loadingSince = 0;
    this.runner.recovered();
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
      // Paused by the viewer, a source that is ready to play counts as loaded (no picture event while paused).
      if (this.paused && !this.pictured && this.phase === 'playing') this.onPicture();
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
      if (this.paused || this.ended || this.runner.current || this.phase !== 'playing') return;
      this.paused = true;
      this.systemPaused = true;
      this.report('progress');
      this.changed();
    }, SYSTEM_PAUSE_MS);
  }

  private startStall(): void {
    if (!this.pictured || this.stallSince) return;
    this.stallSince = Date.now();
    this.stallPosition = this.engine?.getSnapshot().position ?? 0;
    this.stallAfterSeek = this.stallSince - this.seekAt < 2 * SPINNER_MS;
    if (this.playback?.method === 'direct') void this.refreshRepair();
    this.tickStatus();
    this.changed();
  }

  /** A direct play that stalls may wait on a Usenet repair: the playback says so (C04). */
  private async refreshRepair(): Promise<void> {
    const playback = this.playback;
    if (!playback?.playbackId) return;
    try {
      const fresh = await getPlayback(this.options.client, playback.playbackId, this.abort.signal);
      if (this.playback === playback && fresh.playbackId === playback.playbackId)
        this.playback = { ...playback, repair: fresh.repair ?? null };
      this.changed();
    } catch {
      // Unknown repair state: the stall says what it can.
    }
  }

  private clearStall(): void {
    if (!this.stallSince) return;
    this.stallSince = 0;
    this.tickStatus();
    this.changed();
  }

  /** Clock progress: ends a pending seek and a stall nobody cleared (hls.js nudges, D04). */
  private onClock(position: number): void {
    const target = this.seekTarget;
    if (target !== null && position >= target + 0.25) {
      this.seekTarget = null;
      this.settle();
      this.changed();
    }
    if (this.stallSince && position - this.stallPosition >= 1) this.clearStall();
  }

  /** The watchdog waits after a load, a seek or a track switch. */
  private settle(): void {
    this.settleUntil = Date.now() + SETTLE_MS;
    this.monitor.reset();
  }

  /** The watchdog's guards right now (state-matrix § 2 a). */
  private healthContext(health: EngineHealth) {
    const snapshot = this.engine?.getSnapshot();
    const info = this.playback?.mediaInfo;
    return {
      buffering:
        !!this.stallSince || snapshot?.state === 'buffering' || snapshot?.state === 'loading',
      wantsPlayback:
        this.phase === 'playing' &&
        this.pictured &&
        !this.paused &&
        !this.ended &&
        !this.runner.current &&
        !this.offline,
      visible: AppState.currentState !== 'background',
      pictureInPicture: this.pictureInPicture,
      settling: Date.now() < this.settleUntil || this.seekTarget !== null,
      // The server knows: `video: null` is an audio-only file (no picture rules); unknown asks the engine.
      hasVideo: info?.video === null ? false : info?.video ? true : health.hasVideoTrack,
      hasAudio: info?.audioTracks?.length ? true : health.hasAudioTrack,
    };
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
        !!this.runner.current ||
        (this.seekTarget !== null && !this.paused) ||
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
    const state = this.states.at(-1) ?? '';
    if (this.phase === 'starting' && startStuck(state, this.stateSince, now, this.offline)) {
      this.startAbort?.abort();
      return this.giveUp(
        { category: 'T6', code: 'start_stuck' },
        { serverActions: ['retry', 'otherVersion'], params: { state } },
        this.runner.attempts
      );
    }
    const recovery = this.runner.current;
    // A step that already ran (the source reloaded) does not hold the budgets: a reload without a picture fails again.
    const pending = !!recovery && !recovery.running;
    const ready = !pending && !this.offline && this.phase === 'playing';
    // A running step has its own budget: the stall and seek rules must not cancel it (review B1).
    const calm = ready && !this.paused && !recovery?.running;
    // A seek whose clock never arrives, without a stall from the engine, is a stall too (D29).
    if (
      calm &&
      this.seekTarget !== null &&
      !this.stallSince &&
      now - this.seekAt >= CLOCK_FROZEN_MS
    ) {
      this.startStall();
      this.stallAfterSeek = true;
    }
    // The start budget runs while paused too: a source that never loads is not waiting for the viewer.
    if (
      ready &&
      this.loadingSince &&
      !this.pictured &&
      now - this.loadingSince >= this.startBudget()
    ) {
      this.loadingSince = 0;
      this.runner.handle({ category: 'T7', code: 'picture_timeout' });
    } else if (calm && this.stallSince && this.nearEnd() && now - this.stallSince >= HINT_MS) {
      this.finish();
    } else if (calm && this.stallSince && now - this.stallSince >= STALL_LADDER_MS) {
      this.stallSince = 0;
      this.runner.handle(
        stallFailure(this.loadRetry, now, this.stallAfterSeek, this.engine?.kind ?? 'web')
      );
    } else if (this.offline) this.runner.expireOffline(now - this.offlineSince);
    this.tickStatus();
    this.changed();
  }

  /** Spinner, hint and actions over the picture (state-matrix § 2 c). */
  get status(): PlayerStatus {
    return statusOf({
      now: Date.now(),
      phase: this.phase,
      offline: this.offline,
      recovery: this.runner.current,
      loadingSince: this.pictured ? 0 : this.loadingSince,
      stallSince: this.stallSince,
      seekAt: this.seekAt,
      seeking: this.seekTarget !== null,
      paused: this.paused,
      systemPaused: this.systemPaused,
      autoplay: this.autoplay,
      health: this.monitor.finding,
      frozenAt: this.monitor.watchdog.lastGoodPosition ?? 0,
      serverState: this.states.at(-1) ?? '',
      serverStateSince: this.stateSince,
      method: this.playback?.method,
      bitrateKbps: this.playback?.mediaInfo?.bitrateKbps,
      bandwidthBps: this.monitor.last.bandwidthBps,
      fetch: this.monitor.last.fetch,
      conversionRate: this.monitor.last.conversionRate,
      repairing: isRepairing(this.playback?.repair?.state),
      serverRetry:
        this.loadRetry && Date.now() - this.loadRetry.at < LOAD_RETRY_RECENT_MS
          ? this.loadRetry
          : null,
    });
  }

  /** The watchdog's finding below the ladder threshold (hint only). */
  get health() {
    return this.monitor.finding;
  }

  unmute(): void {
    this.setMuted(false);
  }

  /** Every mute and unmute (overlay button, key, hint) goes through here, so the muted-autoplay hint clears with it. */
  setMuted(muted: boolean): void {
    this.engine?.setMuted?.(muted);
    this.muted = effectiveMuted(muted);
    if (!muted && this.autoplay === 'muted') this.autoplay = null;
    this.changed();
  }

  /** A blocked autoplay that starts anyway (media key, system controls): the hint and the pause go. */
  private autoplayResumed(position: number): void {
    if (this.autoplay !== 'blocked' || this.blockedAt === null) return;
    if (this.engine?.getSnapshot().state !== 'playing' || Math.abs(position - this.blockedAt) < 0.5)
      return;
    this.autoplay = null;
    this.blockedAt = null;
    this.paused = false;
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

  /** Playback error on this device: continue with the next method of the server's ranking; false = nothing ran. */
  async stepDown(reason?: string, step?: StepContext): Promise<boolean> {
    const playback = this.playback;
    if (!playback?.playbackId || this.closed || this.phase === 'switching') return false;
    const from = playback.method ?? '';
    const context = step ?? {
      position: this.resumePosition,
      tracks: this.viewerTracks(),
      signal: this.abort.signal,
    };
    const ok = await this.serverSwitch({ stepDown: true }, context);
    if (ok) {
      this.showNotice('stepDown', {
        from,
        to: this.playback?.method ?? '',
        engine: this.playback?.engine === 'vlc' && playback.engine !== 'vlc' ? 'vlc' : '',
        reason: reason ?? '',
      });
    }
    return ok;
  }

  /** Server switch at the position; without `step` it is the viewer's own (refused while switching, cancels recovery). */
  async serverSwitch(body: PlaybackSwitch, step?: StepContext): Promise<boolean> {
    const playback = this.playback;
    if (!playback?.playbackId || this.closed) return false;
    if (!step) {
      if (this.phase === 'switching') return false;
      this.runner.cancel();
    }
    const position = step?.position ?? this.resumePosition;
    const previousPreferences = this.preferences;
    if (body.preferences) this.preferences = body.preferences;
    this.phase = 'switching';
    this.states = [];
    this.changed();
    const signal = step?.signal ?? this.beginSwitch().signal;
    try {
      // Same release: keep the tracks, a client-side subtitle pick is unknown to the server.
      const viewer = step ? step.tracks : this.viewerTracks();
      const tracks =
        body.releaseId || !playback.mediaInfo || !viewer
          ? {}
          : {
              ...(viewer.audio === null ? {} : { audioStreamIndex: viewer.audio }),
              subtitleStreamIndex: viewer.subtitle ?? -1,
            };
      const single = !body.releaseId && (playback.mediaInfo?.audioTracks?.length ?? 2) <= 1;
      const switched = await switchPlayback(this.options.client, playback.playbackId, {
        ...tracks,
        ...body,
        ...(body.preferences ? { preferences: this.requestPreferences(single) } : {}),
        positionTicks: Math.round(position * TICKS_PER_SECOND),
      });
      const ready = await this.wait(switched, !!step, signal);
      if (!ready) {
        // The new revision failed (start_timeout, capacity …): the old source still plays, so it simply stays (B19).
        if (!step && this.oldSourcePlays()) {
          this.keepOldSource(playback, previousPreferences);
          return false;
        }
        if (!step) await this.restore(playback, position, previousPreferences, signal);
        return false;
      }
      if (signal.aborted) throw signal.reason;
      await this.attach(ready, position);
      return true;
    } catch (error) {
      if (this.closed) return false;
      // A step that ran out of its budget: the runner turns it into the next failure.
      if (step?.signal.aborted) throw error;
      // The viewer's switch never got ready: the old playback is switched away, so the ladder starts anew there.
      if (!step && signal.aborted) {
        this.phase = 'playing';
        this.runner.handle({ category: 'T6', code: 'step_timeout' }, { detached: true, position });
        return false;
      }
      const appError = toAppError(error);
      if (step) {
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
      await this.restore(playback, position, previousPreferences, signal);
      return false;
    }
  }

  /** A refused user switch: go back to what played before and say why. */
  private async restore(
    previous: Playback,
    position: number,
    preferences: PlaybackPreferences,
    signal: AbortSignal = this.abort.signal
  ): Promise<void> {
    this.preferences = preferences;
    const code = this.lastError || 'playback_failed';
    try {
      // The server does not switch a failed playback, so start a new one with the previous choices.
      if (previous.playbackId)
        await stopPlayback(this.options.client, previous.playbackId).catch(() => undefined);
      const selected = <T extends { selected?: boolean; index: number }>(list?: T[] | null) =>
        list?.find((track) => track.selected)?.index ?? null;
      const switched = await startPlayback(
        this.options.client,
        this.startRequest(
          position,
          {
            audio: selected(previous.mediaInfo?.audioTracks),
            subtitle: selected(previous.mediaInfo?.subtitleTracks),
          },
          previous.version?.releaseId,
          previous
        ),
        signal
      );
      const ready = await this.wait(switched, true, signal);
      if (!ready) return;
      await this.attach(ready, position);
      const status = this.lastErrorStatus;
      this.showNotice(
        'switchFailed',
        status === undefined ? { code } : { code, status: `${status}` }
      );
    } catch (error) {
      if (this.closed) return;
      // A switch budget that ran out aborted the restore: its own card, never "aborted" (review R4).
      const { failure, extra } = this.failureOf(signal.aborted ? signal.reason : error);
      this.giveUp(failure, extra, this.runner.attempts);
    }
  }

  /** The engine still shows the source from before a switch (it was never told to load another one). */
  private oldSourcePlays(): boolean {
    const state = this.engine?.getSnapshot().state;
    return this.pictured && (state === 'playing' || state === 'paused' || state === 'buffering');
  }

  /** A failed switch whose old source still plays: back to it with the previous choices, and say why. */
  private keepOldSource(previous: Playback, preferences: PlaybackPreferences): void {
    this.endSwitch();
    this.playback = previous;
    this.preferences = preferences;
    this.states = [];
    this.phase = 'playing';
    this.showNotice('switchFailed', { code: this.lastError || 'start_timeout' });
  }

  /** A viewer's switch gets a step's budget (recovery/step-budget). */
  private beginSwitch(): StepBudget {
    this.endSwitch();
    this.switchBudget = new StepBudget();
    return this.switchBudget;
  }

  private endSwitch(): void {
    this.switchBudget?.end();
    this.switchBudget = null;
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
    await this.pickAudio(track);
    this.runner.retrack(this.viewerTracks());
  }

  private async pickAudio(track: AudioTrack): Promise<void> {
    this.settle();
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
    // The in-session switch did not confirm: say that the stream restarted for the new audio (D32).
    if (ok && fallback) this.showNotice('audioRestarted');
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
    await this.pickSubtitle(track);
    this.runner.retrack(this.viewerTracks());
  }

  private async pickSubtitle(track: SubtitleTrack | null): Promise<void> {
    this.settle();
    this.subtitleRetry.clear();
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
    this.seekTarget = clamped;
    this.monitor.nativeClock = null;
    this.monitor.watchdog.reset();
    // A step that waits resumes where the viewer is now, not where the failure was (review B4).
    this.runner.reposition(clamped);
    if (this.pendingSeek) clearTimeout(this.pendingSeek.timer);
    this.pendingSeek = null;
    // A transcode restarts ffmpeg for every far seek: quick repeats become one seek (D31).
    if (this.playback?.method === 'transcode') {
      const timer = setTimeout(() => {
        this.pendingSeek = null;
        if (this.engine === engine && !this.closed) engine.seek(clamped);
      }, SEEK_DEBOUNCE_MS);
      this.pendingSeek = { target: clamped, timer };
    } else engine.seek(clamped);
    this.tickStatus();
    this.changed();
  }

  seekBy(delta: number): void {
    this.seekTo(this.position + delta);
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    const position = this.ended ? this.duration : this.resumePosition;
    this.abort.abort();
    this.runner.cancel();
    // A viewer's switch in flight stops with the player (its requests use the switch budget's signal).
    this.switchBudget?.cancel();
    this.switchBudget = null;
    this.subtitleRetry.clear();
    if (this.pendingSeek) clearTimeout(this.pendingSeek.timer);
    this.autoRetry.cancel();
    this.stopStatusTicker();
    this.networkOff?.();
    this.monitor.stop();
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
