import type { EngineEvent, EngineKind, EngineVideoInfo, PlayerEngine } from './engines/types';

/** Playback has resumed once the clock is this far past the target (seconds). */
export const RESUME_DELTA = 0.25;

export type SeekSample = { from: number; target: number; ms?: number };
export type TrackSwitchSample = {
  kind: 'audio' | 'subtitle';
  label: string;
  via: 'engine' | 'server';
  ms?: number;
};
export type KeySample = { key: string; action: string; at: number };

export type PlaybackMetrics = {
  engine: EngineKind;
  /** Engine's own first-frame signal after `load` (ms). */
  ttffMs?: number;
  /** Uniform across engines: `load` until the clock passed the start by RESUME_DELTA (ms). */
  startupMs?: number;
  seeks: SeekSample[];
  rebuffers: number;
  rebufferMs: number;
  droppedFrames?: number;
  totalFrames?: number;
  decoder?: string;
  decoderHardware?: boolean;
  bandwidth?: number;
  video?: EngineVideoInfo;
  /** Most tracks the engine listed (lists empty out when an engine stops). */
  audioTracks: number;
  subtitleTracks: number;
  switches: TrackSwitchSample[];
  keys: KeySample[];
  errors: string[];
  ended: boolean;
};

type PendingSwitch = { sample: TrackSwitchSample; id: string | null; at: number };

/** Collects start-up, seek, buffering, track and key metrics from one engine's events. */
export class MetricsRecorder {
  readonly metrics: PlaybackMetrics;
  private loadAt = 0;
  private startPosition = 0;
  private pendingSeek: { sample: SeekSample; at: number } | null = null;
  private pendingSwitch: PendingSwitch | null = null;
  private stallAt: number | null = null;
  private started = false;
  private listeners = new Set<() => void>();
  private unsubscribe: () => void;

  constructor(
    private readonly engine: PlayerEngine,
    private readonly now: () => number = () => Date.now()
  ) {
    this.metrics = {
      engine: engine.kind,
      seeks: [],
      rebuffers: 0,
      rebufferMs: 0,
      audioTracks: 0,
      subtitleTracks: 0,
      switches: [],
      keys: [],
      errors: [],
      ended: false,
    };
    this.unsubscribe = engine.subscribe((event) => this.onEvent(event));
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  markLoad(startPosition = 0): void {
    this.loadAt = this.now();
    this.startPosition = startPosition;
    this.started = false;
  }

  /** A new source in the same engine (server switch): keeps the first start-up numbers. */
  markReload(): void {
    this.pendingSeek = null;
    this.stallAt = null;
  }

  markSeek(target: number): void {
    const sample: SeekSample = { from: this.engine.getSnapshot().position, target };
    this.metrics.seeks.push(sample);
    this.pendingSeek = { sample, at: this.now() };
    this.changed();
  }

  markSwitch(
    kind: TrackSwitchSample['kind'],
    id: string | null,
    label: string,
    via: 'engine' | 'server'
  ) {
    const sample: TrackSwitchSample = { kind, label, via };
    this.metrics.switches.push(sample);
    this.pendingSwitch = via === 'engine' ? { sample, id, at: this.now() } : null;
    this.changed();
    return sample;
  }

  /** A server-side switch completes when the new rendition plays again. */
  completeSwitch(sample: TrackSwitchSample, startedAt: number): void {
    sample.ms = this.now() - startedAt;
    this.changed();
  }

  markKey(key: string, action: string): void {
    this.metrics.keys = [...this.metrics.keys.slice(-9), { key, action, at: this.now() }];
    this.changed();
  }

  setDecoder(decoder: string | undefined, hardware: boolean | undefined): void {
    if (decoder === this.metrics.decoder && hardware === this.metrics.decoderHardware) return;
    this.metrics.decoder = decoder;
    this.metrics.decoderHardware = hardware;
    this.changed();
  }

  addDroppedFrames(count: number): void {
    this.metrics.droppedFrames = (this.metrics.droppedFrames ?? 0) + count;
    this.changed();
  }

  private onEvent(event: EngineEvent): void {
    const now = this.now();
    const metrics = this.metrics;
    switch (event.type) {
      case 'firstFrame':
        if (metrics.ttffMs === undefined && this.loadAt) metrics.ttffMs = now - this.loadAt;
        break;
      case 'time': {
        const resumed = this.engine.getSnapshot().state === 'playing';
        if (!this.started && this.loadAt && event.position >= this.startPosition + RESUME_DELTA) {
          this.started = true;
          metrics.startupMs = Math.max(0, now - this.loadAt - RESUME_DELTA * 1000);
        }
        const seek = this.pendingSeek;
        if (
          seek &&
          resumed &&
          event.position >= seek.sample.target + RESUME_DELTA &&
          event.position <= seek.sample.target + 5
        ) {
          seek.sample.ms = Math.max(0, now - seek.at - RESUME_DELTA * 1000);
          this.pendingSeek = null;
        }
        break;
      }
      case 'buffering':
        if (event.buffering && this.stallAt === null && !this.pendingSeek) {
          metrics.rebuffers += 1;
          this.stallAt = now;
        } else if (!event.buffering && this.stallAt !== null) {
          metrics.rebufferMs += now - this.stallAt;
          this.stallAt = null;
        }
        break;
      case 'tracks': {
        metrics.video = event.tracks.video ?? metrics.video;
        metrics.audioTracks = Math.max(metrics.audioTracks, event.tracks.audio.length);
        metrics.subtitleTracks = Math.max(metrics.subtitleTracks, event.tracks.subtitles.length);
        const pending = this.pendingSwitch;
        if (pending) {
          const list =
            pending.sample.kind === 'audio' ? event.tracks.audio : event.tracks.subtitles;
          const selected = list.find((track) => track.selected)?.id ?? null;
          if (selected === pending.id) {
            pending.sample.ms = now - pending.at;
            this.pendingSwitch = null;
          }
        }
        break;
      }
      case 'stats':
        if (event.stats.droppedFrames !== undefined)
          metrics.droppedFrames = event.stats.droppedFrames;
        if (event.stats.totalFrames !== undefined) metrics.totalFrames = event.stats.totalFrames;
        if (event.stats.decoder !== undefined) metrics.decoder = event.stats.decoder;
        if (event.stats.bandwidth !== undefined) metrics.bandwidth = event.stats.bandwidth;
        break;
      case 'error':
        metrics.errors = [...metrics.errors, event.reason];
        break;
      case 'ended':
        metrics.ended = true;
        break;
      case 'state':
        break;
    }
    this.changed();
  }

  dispose(): void {
    this.unsubscribe();
    this.listeners.clear();
  }
}
