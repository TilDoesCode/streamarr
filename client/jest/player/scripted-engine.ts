import type { EngineHealth } from '@/player/health/types';
import type {
  EngineEvent,
  EngineKind,
  EngineSnapshot,
  EngineSource,
  EngineState,
  EngineTracks,
  PlayerEngine,
} from '@/player/engines/types';

/** Health counters a watchdog reads (state-matrix § 2 a); `undefined` = the platform cannot tell. */
export type ScriptedHealth = EngineHealth;

/** One scripted step: an engine event, a health change or a pause in fake time. */
export type ScriptStep =
  EngineEvent | { type: 'health'; health: ScriptedHealth } | { type: 'wait'; ms: number };

const EMPTY_TRACKS: EngineTracks = { audio: [], subtitles: [] };

/** A PlayerEngine whose every native event, error and health counter is driven by the test. */
export class ScriptedEngine implements PlayerEngine {
  readonly Surface = () => null;
  supportsPictureInPicture = false;
  supportsAirPlay = false;
  snapshot: EngineSnapshot = {
    state: 'idle',
    position: 0,
    duration: 0,
    buffered: 0,
    tracks: EMPTY_TRACKS,
    stats: {},
  };
  health: ScriptedHealth = {};
  readonly sources: EngineSource[] = [];
  /** Commands in order of arrival, e.g. `load`, `play`, `seek:42`. */
  readonly commands: string[] = [];
  private listeners = new Set<(event: EngineEvent) => void>();

  constructor(readonly kind: EngineKind = 'expo-video') {}

  load = jest.fn((source: EngineSource) => {
    this.sources.push(source);
    this.commands.push('load');
    this.snapshot = {
      ...this.snapshot,
      state: 'loading',
      position: source.startPosition ?? 0,
      buffered: 0,
    };
  });
  play = jest.fn(() => void this.commands.push('play'));
  pause = jest.fn(() => void this.commands.push('pause'));
  seek = jest.fn((position: number) => {
    this.commands.push(`seek:${position}`);
    this.snapshot = { ...this.snapshot, position };
  });
  // Like the real engines: a pick changes the selection and is echoed as a tracks event.
  setAudioTrack = jest.fn((id: string) => {
    this.commands.push(`audio:${id}`);
    this.select('audio', id);
  });
  setSubtitleTrack = jest.fn((id: string | null) => {
    this.commands.push(`subtitle:${id}`);
    this.select('subtitles', id);
  });
  setMuted = jest.fn((muted: boolean) => void this.commands.push(`muted:${muted}`));
  startPictureInPicture = jest.fn(() => void this.commands.push('pip'));
  shutdown = jest.fn(() => {
    this.commands.push('shutdown');
    return Promise.resolve();
  });
  release = jest.fn(() => void this.commands.push('release'));
  readHealth: (() => Promise<ScriptedHealth>) | undefined = jest.fn(() =>
    Promise.resolve({ ...this.health })
  );

  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  getSnapshot = (): EngineSnapshot => this.snapshot;

  get source(): EngineSource | undefined {
    return this.sources.at(-1);
  }

  /** Emits like a real engine: the snapshot follows state, time and track events first. */
  emit(event: EngineEvent): void {
    if (event.type === 'state') this.snapshot = { ...this.snapshot, state: event.state };
    else if (event.type === 'time')
      this.snapshot = {
        ...this.snapshot,
        position: event.position,
        duration: event.duration,
        buffered: event.buffered ?? this.snapshot.buffered,
      };
    else if (event.type === 'tracks') this.snapshot = { ...this.snapshot, tracks: event.tracks };
    // A failed engine forgets its clock, like ExoPlayer/AVPlayer/hls.js after a fatal error.
    else if (event.type === 'error')
      this.snapshot = { ...this.snapshot, state: 'error', position: 0 };
    else if (event.type === 'ended') this.snapshot = { ...this.snapshot, state: 'ended' };
    for (const listener of [...this.listeners]) listener(event);
  }

  private select(kind: 'audio' | 'subtitles', id: string | null): void {
    const list = this.snapshot.tracks[kind];
    if (!list.length) return;
    const tracks = {
      ...this.snapshot.tracks,
      [kind]: list.map((track) => ({ ...track, selected: track.id === id })),
    };
    this.emit({ type: 'tracks', tracks });
  }

  state(state: EngineState): void {
    this.emit({ type: 'state', state });
  }

  time(position: number, duration = this.snapshot.duration): void {
    this.emit({ type: 'time', position, duration });
  }

  /** A healthy start: first frame, playing, clock at the start position. */
  started(duration = 600): void {
    this.emit({ type: 'firstFrame' });
    this.state('playing');
    this.time(this.snapshot.position, duration);
  }

  fail(reason: string): void {
    this.emit({ type: 'error', reason });
  }

  setHealth(health: ScriptedHealth): void {
    this.health = { ...this.health, ...health };
  }

  /** Plays a script in order; `wait` advances jest's fake timers (call `jest.useFakeTimers()` first). */
  async run(steps: readonly ScriptStep[]): Promise<void> {
    for (const step of steps) {
      if (step.type === 'wait') await jest.advanceTimersByTimeAsync(step.ms);
      else if (step.type === 'health') this.setHealth(step.health);
      else this.emit(step);
    }
  }
}
