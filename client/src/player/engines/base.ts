import type { EngineEvent, EngineSnapshot, EngineSource, EngineState, EngineTracks } from './types';

type Listener = (event: EngineEvent) => void;

const EMPTY_TRACKS: EngineTracks = { audio: [], subtitles: [] };

/** Event fan-out and the last known state shared by every engine. */
export abstract class EngineBase {
  private listeners = new Set<Listener>();
  private snapshot: EngineSnapshot = {
    state: 'idle',
    position: 0,
    duration: 0,
    buffered: 0,
    tracks: EMPTY_TRACKS,
    stats: {},
  };
  protected released = false;
  protected source: EngineSource | null = null;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): EngineSnapshot {
    return this.snapshot;
  }

  protected emit(event: EngineEvent): void {
    if (this.released) return;
    const current = this.snapshot;
    switch (event.type) {
      case 'state':
        if (current.state === event.state) return;
        this.snapshot = { ...current, state: event.state };
        break;
      case 'time':
        this.snapshot = {
          ...current,
          position: event.position,
          duration: event.duration || current.duration,
          buffered: event.buffered ?? current.buffered,
        };
        break;
      case 'tracks':
        this.snapshot = { ...current, tracks: event.tracks };
        break;
      case 'stats':
        this.snapshot = { ...current, stats: { ...current.stats, ...event.stats } };
        break;
      default:
        break;
    }
    for (const listener of this.listeners) listener(event);
  }

  protected setState(state: EngineState): void {
    this.emit({ type: 'state', state });
  }

  protected resetForLoad(source: EngineSource): void {
    this.source = source;
    this.snapshot = {
      state: 'loading',
      position: source.startPosition ?? 0,
      duration: 0,
      buffered: 0,
      tracks: EMPTY_TRACKS,
      stats: {},
    };
    for (const listener of this.listeners) listener({ type: 'state', state: 'loading' });
  }

  release(): void {
    this.released = true;
    this.listeners.clear();
  }
}

/** Minimal external store for engines whose native view is driven by props. */
export class PropsStore<T> {
  private listeners = new Set<() => void>();

  constructor(private value: T) {}

  get = (): T => this.value;

  set(patch: Partial<T>): void {
    this.value = { ...this.value, ...patch };
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}
