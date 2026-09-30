import { readCodecLogAsync, type DeviceProfile, type MediaCapsReport } from '@modules/media-caps';
import { Platform } from 'react-native';

import type { ApiClient } from '@/api/client';
import { toAppError } from '@/api/errors';
import {
  createEngine,
  type EngineKind,
  type EngineOptions,
  type PlayerEngine,
} from '@/player/engines';
import { MetricsRecorder, RESUME_DELTA } from '@/player/metrics';
import {
  mediaUrl,
  reportProgress,
  startPlayback,
  stopPlayback,
  switchPlayback,
  TICKS_PER_SECOND,
  waitForPlayback,
  type Playback,
  type PlaybackPreferences,
  type PlaybackSwitch,
} from '@/player/playback-api';

import type { VariantCase } from './dev-world';

export type SessionPhase = 'starting' | 'playing' | 'failed' | 'stopped';
type AudioTrack = NonNullable<NonNullable<Playback['mediaInfo']>['audioTracks']>[number];
type SubtitleTrack = NonNullable<NonNullable<Playback['mediaInfo']>['subtitleTracks']>[number];

export type SessionOptions = {
  client: ApiClient;
  serverUrl: string;
  profile: DeviceProfile;
  caps: MediaCapsReport;
  nativeEngine: EngineKind;
  engineOptions?: EngineOptions;
  preferences: PlaybackPreferences;
  variant: VariantCase;
  /** Start position in seconds (browse: resume or start over). */
  startSeconds?: number;
  /** Lab diagnostics (decoder log via logcat); off for normal playback. */
  diagnostics?: boolean;
};

/** One row of the comparison table. */
export type ResultRow = {
  variant: string;
  candidate: EngineKind;
  preference?: string;
  engine?: EngineKind;
  method?: string;
  serverEngine?: string;
  fallbackFrom?: string;
  states: string;
  apiMs?: number;
  ttffMs?: number;
  startupMs?: number;
  seekMs: (number | null)[];
  rebuffers: number;
  droppedFrames?: number;
  totalFrames?: number;
  decoder?: string;
  hardware?: boolean;
  video?: string;
  audioTracks: number;
  subtitleTracks: number;
  switches: string[];
  reasons: string;
  vlcDirectRendering?: boolean;
  error?: string;
};

const HEARTBEAT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Releases an engine after its Surface had time to unmount. */
function retire(engine: PlayerEngine | null, recorder: MetricsRecorder | null): void {
  recorder?.dispose();
  if (engine) setTimeout(() => engine.release(), 500);
}

/** Runs one playback of the lab: playback API, engine, metrics, heartbeat, decoder log, benchmark. */
export class PlayerSession {
  phase: SessionPhase = 'starting';
  playback: Playback | null = null;
  engine: PlayerEngine | null = null;
  recorder: MetricsRecorder | null = null;
  serverStates: string[] = [];
  apiMs?: number;
  error?: string;
  private listeners = new Set<() => void>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private loadEpoch = 0;
  private paused = false;
  private abort = new AbortController();
  private stopApplying: (() => void) | null = null;

  constructor(readonly options: SessionOptions) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  get closed(): boolean {
    return this.abort.signal.aborted;
  }

  async start(): Promise<void> {
    const { client, variant, profile, preferences, startSeconds = 0 } = this.options;
    const began = Date.now();
    try {
      const created = await startPlayback(
        client,
        {
          workId: variant.workId,
          releaseId: variant.releaseId,
          startPositionTicks: startSeconds
            ? Math.round(startSeconds * TICKS_PER_SECOND)
            : undefined,
          device: profile,
          preferences,
        },
        this.abort.signal
      );
      const ready = await waitForPlayback(
        client,
        created,
        (update) => this.onPlayback(update),
        this.abort.signal
      );
      this.apiMs = Date.now() - began;
      if (ready.state === 'failed') {
        this.phase = 'failed';
        this.error = ready.error?.code ?? 'failed';
        this.changed();
        return;
      }
      await this.attach(ready, startSeconds);
      void reportProgress(client, ready, 'start', startSeconds, 0).catch(() => undefined);
      this.timers.push(setInterval(() => this.heartbeat(), HEARTBEAT_MS));
      if (Platform.OS === 'android' && this.options.diagnostics !== false)
        this.timers.push(setInterval(() => void this.pollCodecs(), 2000));
    } catch (error) {
      if (this.closed) return;
      this.phase = 'failed';
      this.error = toAppError(error).code;
      this.changed();
    }
  }

  private onPlayback(update: Playback): void {
    this.playback = update;
    if (update.state && this.serverStates[this.serverStates.length - 1] !== update.state)
      this.serverStates = [...this.serverStates, update.state];
    this.changed();
  }

  /** Engine for the server's choice: VLC when it says so, else the candidate under test. */
  private engineFor(playback: Playback): EngineKind {
    return playback.engine === 'vlc' ? 'vlc' : this.options.nativeEngine;
  }

  private async attach(playback: Playback, position: number): Promise<void> {
    const kind = this.engineFor(playback);
    const initial = !this.engine || this.engine.kind !== kind;
    let engine = this.engine;
    if (!engine || initial) {
      await this.engine?.shutdown?.();
      retire(this.engine, this.recorder);
      engine = createEngine(kind, this.options.engineOptions);
      this.engine = engine;
      this.recorder = new MetricsRecorder(engine);
      this.recorder.onChange(() => this.changed());
    }
    this.playback = playback;
    this.phase = 'playing';
    this.paused = false;
    this.loadEpoch = Date.now();
    if (initial) this.recorder?.markLoad(position);
    else this.recorder?.markReload();
    this.applyServerTracks(engine, playback);
    engine.load({
      uri: mediaUrl(this.options.serverUrl, playback.url ?? ''),
      kind: playback.method === 'direct' ? 'progressive' : 'hls',
      startPosition: position || undefined,
    });
    this.changed();
  }

  /** Once the engine lists the tracks, selects what the server decided (e.g. forced subtitles, preferred audio). */
  private applyServerTracks(engine: PlayerEngine, playback: Playback): void {
    this.stopApplying?.();
    const info = playback.mediaInfo;
    const local = (info?.subtitleTracks ?? []).filter(
      (track) => track.deliveredAs === 'embedded' || track.deliveredAs === 'webvtt'
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
      this.stopApplying = null;
    };
    this.stopApplying = done;
  }

  private heartbeat(): void {
    const { engine, playback } = this;
    if (!engine || !playback) return;
    const snapshot = engine.getSnapshot();
    void reportProgress(
      this.options.client,
      playback,
      'progress',
      snapshot.position,
      snapshot.duration
    ).catch(() => undefined);
  }

  private async pollCodecs(): Promise<void> {
    const recorder = this.recorder;
    if (!recorder) return;
    const entries = await readCodecLogAsync(this.loadEpoch - 1000).catch(() => []);
    const videoNames = new Set(this.options.caps.videoDecoders.map((decoder) => decoder.name));
    let decoder: string | undefined;
    let dropped = 0;
    for (const entry of entries) {
      if (entry.event === 'droppedFrames') dropped += entry.count ?? 0;
      else if (entry.event === 'decoderInitialized' && entry.kind === 'video')
        decoder = entry.codec;
      else if (entry.codec && videoNames.has(entry.codec) && entry.event !== 'release')
        decoder = entry.codec;
    }
    const info = this.options.caps.videoDecoders.find((item) => item.name === decoder);
    if (this.engine?.kind === 'vlc' && !decoder) recorder.setDecoder('libvlc', false);
    else if (decoder) recorder.setDecoder(decoder, info?.hardware);
    if (dropped) recorder.metrics.droppedFrames = dropped;
  }

  /** Uses the intended state; engine states are transient while seeking or buffering. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) this.engine?.pause();
    else this.engine?.play();
  }

  togglePlay(): void {
    this.setPaused(!this.paused);
  }

  seekTo(target: number): void {
    const engine = this.engine;
    if (!engine) return;
    const duration = engine.getSnapshot().duration;
    const clamped = Math.max(0, duration ? Math.min(target, duration - 1) : target);
    this.recorder?.markSeek(clamped);
    engine.seek(clamped);
  }

  seekBy(delta: number): void {
    const engine = this.engine;
    if (engine) this.seekTo(engine.getSnapshot().position + delta);
  }

  /** Engine track that renders server track `index` of `kind` locally, if the delivery allows it. */
  private localTrackId(kind: 'audio' | 'subtitle', index: number): string | null {
    const playback = this.playback;
    const engine = this.engine;
    if (!playback?.mediaInfo || !engine) return null;
    const tracks = engine.getSnapshot().tracks;
    if (kind === 'audio') {
      const list = playback.mediaInfo.audioTracks ?? [];
      const track = list.find((item) => item.index === index);
      if (track?.deliveredAs !== 'original') return null;
      return tracks.audio[list.indexOf(track)]?.id ?? null;
    }
    const list = (playback.mediaInfo.subtitleTracks ?? []).filter(
      (item) => item.deliveredAs === 'embedded' || item.deliveredAs === 'webvtt'
    );
    const position = list.findIndex((item) => item.index === index);
    return position >= 0 ? (tracks.subtitles[position]?.id ?? null) : null;
  }

  async selectAudio(track: AudioTrack): Promise<void> {
    const label = track.title ?? track.language ?? String(track.index);
    const local = this.localTrackId('audio', track.index);
    if (local !== null) {
      this.recorder?.markSwitch('audio', local, label, 'engine');
      this.engine?.setAudioTrack(local);
      return;
    }
    await this.serverSwitch('audio', label, { audioStreamIndex: track.index });
  }

  async selectSubtitle(track: SubtitleTrack | null): Promise<void> {
    const label = track ? (track.title ?? track.language ?? String(track.index)) : '-1';
    const burnedIn = this.playback?.mediaInfo?.subtitleTracks?.some(
      (item) => item.selected && item.deliveredAs === 'burnedIn'
    );
    if (!track) {
      if (burnedIn) return this.serverSwitch('subtitle', label, { subtitleStreamIndex: -1 });
      this.recorder?.markSwitch('subtitle', null, label, 'engine');
      this.engine?.setSubtitleTrack(null);
      return;
    }
    const local = this.localTrackId('subtitle', track.index);
    if (local !== null && !burnedIn) {
      this.recorder?.markSwitch('subtitle', local, label, 'engine');
      this.engine?.setSubtitleTrack(local);
      return;
    }
    await this.serverSwitch('subtitle', label, { subtitleStreamIndex: track.index });
  }

  /** New rendition from the server (e.g. another audio track in a remux), resumed at the same position. */
  async serverSwitch(
    kind: 'audio' | 'subtitle',
    label: string,
    body: PlaybackSwitch
  ): Promise<void> {
    const { engine, recorder, playback } = this;
    if (!engine || !recorder || !playback?.playbackId) return;
    const began = Date.now();
    const sample = recorder.markSwitch(kind, null, label, 'server');
    const position = engine.getSnapshot().position;
    try {
      const switched = await switchPlayback(this.options.client, playback.playbackId, {
        ...body,
        positionTicks: Math.round(position * TICKS_PER_SECOND),
      });
      const ready = await waitForPlayback(
        this.options.client,
        switched,
        (update) => this.onPlayback(update),
        this.abort.signal
      );
      if (ready.state !== 'ready') throw new Error(ready.error?.code ?? 'switch_failed');
      await this.attach(ready, position);
      const current = this.engine;
      const unsubscribe = current?.subscribe((event) => {
        if (event.type === 'time' && event.position >= position + RESUME_DELTA) {
          this.recorder?.completeSwitch(sample, began + RESUME_DELTA * 1000);
          unsubscribe?.();
        }
      });
    } catch (error) {
      this.recorder?.metrics.errors.push(toAppError(error).code);
      this.changed();
    }
  }

  private async until(check: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.closed) return false;
      if (check()) return true;
      await sleep(200);
    }
    return false;
  }

  /** Fixed measurement: start-up, two seeks, then local/server track switches where the media has them. */
  async bench(): Promise<void> {
    if (!(await this.until(() => this.phase !== 'starting', 120_000)) || this.phase !== 'playing')
      return;
    const started = await this.until(() => this.recorder?.metrics.startupMs !== undefined, 30_000);
    if (!started) return;
    await sleep(3000);
    const duration = this.engine?.getSnapshot().duration ?? 0;
    for (const target of [Math.min(60, Math.max(20, duration / 2)), 10]) {
      if (this.closed) return;
      this.seekTo(target);
      const seek = this.recorder?.metrics.seeks.at(-1);
      await this.until(() => seek?.ms !== undefined, 20_000);
      await sleep(2000);
    }
    const info = this.playback?.mediaInfo;
    const audio = info?.audioTracks ?? [];
    const other = audio.find((track) => !track.selected);
    const current = audio.find((track) => track.selected);
    if (other && current) {
      await this.selectAudio(other);
      await this.until(() => this.recorder?.metrics.switches.at(-1)?.ms !== undefined, 20_000);
      await sleep(2500);
    }
    const subtitles = (this.playback?.mediaInfo?.subtitleTracks ?? []).filter(
      (track) => track.deliveredAs === 'embedded' || track.deliveredAs === 'webvtt'
    );
    for (const track of subtitles.slice(0, 2)) {
      await this.selectSubtitle(track);
      await this.until(() => this.recorder?.metrics.switches.at(-1)?.ms !== undefined, 10_000);
      await sleep(2500);
    }
    if (subtitles.length) {
      await this.selectSubtitle(null);
      await sleep(1000);
    }
  }

  result(): ResultRow {
    const metrics = this.recorder?.metrics;
    const playback = this.playback;
    const video = metrics?.video;
    return {
      variant: this.options.variant.id,
      candidate: this.options.nativeEngine,
      preference: this.options.preferences.engine ?? undefined,
      engine: this.engine?.kind,
      method: playback?.method ?? undefined,
      serverEngine: playback?.engine ?? undefined,
      fallbackFrom: playback?.fallbackFrom?.name ?? undefined,
      states: this.serverStates.join('>'),
      apiMs: this.apiMs,
      ttffMs: metrics?.ttffMs,
      startupMs: metrics?.startupMs,
      seekMs: metrics?.seeks.map((seek) => seek.ms ?? null) ?? [],
      rebuffers: metrics?.rebuffers ?? 0,
      droppedFrames: metrics?.droppedFrames,
      totalFrames: metrics?.totalFrames,
      decoder: metrics?.decoder,
      hardware: metrics?.decoderHardware,
      video: video?.width
        ? `${video.width}x${video.height} ${video.range ?? ''}`.trim()
        : undefined,
      audioTracks: metrics?.audioTracks ?? 0,
      subtitleTracks: metrics?.subtitleTracks ?? 0,
      switches:
        metrics?.switches.map((item) => `${item.kind}:${item.via}:${item.ms ?? 'pending'}`) ?? [],
      reasons: (playback?.decision?.reasons ?? []).map((reason) => reason.code).join(','),
      vlcDirectRendering:
        this.engine?.kind === 'vlc'
          ? !!this.options.engineOptions?.vlc?.directRendering
          : undefined,
      error: this.error ?? (metrics?.errors.length ? metrics.errors.join('; ') : undefined),
    };
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.abort.abort();
    for (const timer of this.timers) clearInterval(timer);
    const { engine, playback } = this;
    if (engine && playback) {
      const snapshot = engine.getSnapshot();
      await reportProgress(
        this.options.client,
        playback,
        'stop',
        snapshot.position,
        snapshot.duration
      ).catch(() => undefined);
    }
    if (playback?.playbackId)
      await stopPlayback(this.options.client, playback.playbackId).catch(() => undefined);
    await engine?.shutdown?.();
    this.phase = 'stopped';
    this.changed();
    retire(engine, this.recorder);
  }
}
