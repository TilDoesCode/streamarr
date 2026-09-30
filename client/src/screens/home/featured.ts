import { useSyncExternalStore } from 'react';

/** What the home hero shows: the focused card on TV, the top pick elsewhere. */
export type Featured = {
  key: string;
  kind: 'movie' | 'series';
  tmdbId: number;
  title: string;
  eyebrow: string;
  backdropUrl?: string | null;
  year?: number | null;
  overview?: string | null;
  /** Episode line of continue watching / next up. */
  detail?: string;
  progress?: number;
};

const DELAY_MS = 250;

function sameFeatured(a: Featured, b: Featured): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof Featured)[]);
  return [...keys].every((key) => a[key] === b[key]);
}

/** Focus changes arrive per D-pad press; the hero settles after a short pause so fast moves stay cheap. */
export class FeaturedStore {
  private current: Featured | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<() => void>();

  get = () => this.current;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  set(item: Featured, immediate = false) {
    clearTimeout(this.timer);
    const apply = () => {
      if (this.current && sameFeatured(this.current, item)) return;
      this.current = item;
      for (const listener of this.listeners) listener();
    };
    if (immediate) apply();
    else this.timer = setTimeout(apply, DELAY_MS);
  }

  /** Sets a default only while nothing was featured yet. */
  initial(item: Featured | undefined) {
    if (item && !this.current) this.set(item, true);
  }

  dispose() {
    clearTimeout(this.timer);
  }
}

export function useFeatured(store: FeaturedStore): Featured | null {
  return useSyncExternalStore(store.subscribe, store.get);
}
