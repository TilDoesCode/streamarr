import { useSyncExternalStore } from 'react';

import type { CatalogSpec } from '@/components/spec';

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
  tint?: string | null;
  tint2?: string | null;
  spec?: CatalogSpec | null;
};

// The ambient backdrop debounces again (150 ms); the hero itself settles quickly.
const DELAY_MS = 150;

function sameFeatured(a: Featured, b: Featured): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof Featured)[]);
  return [...keys].every((key) => a[key] === b[key]);
}

/** Focus changes arrive per D-pad press; the hero settles after a short pause so fast moves stay cheap. */
export class FeaturedStore {
  private current: Featured | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<() => void>();
  /** Something was focused or hovered; defaults no longer replace it. */
  private chosen = false;
  /** The latest focused/hovered title, before the debounce applies it. */
  private pending: Featured | null = null;

  get = () => this.current;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  set(item: Featured, immediate = false) {
    clearTimeout(this.timer);
    this.pending = item;
    const apply = () => {
      this.chosen = true;
      this.pending = null;
      this.replace(item);
    };
    if (immediate) apply();
    else this.timer = setTimeout(apply, DELAY_MS);
  }

  /** What a Play key should start: the focused card, even while the hero still shows the previous title. */
  playTarget(): Featured | null {
    return this.pending ?? this.current;
  }

  /** Applies a pending focus change now. */
  flush() {
    if (this.pending) this.set(this.pending, true);
  }

  /** The first card's title: shown until something else is featured, kept current while it loads. */
  lead(item: Featured) {
    if (this.chosen && this.current?.key !== item.key) return;
    this.replace(item);
  }

  /** Sets a default only while nothing was featured yet. */
  initial(item: Featured | undefined) {
    if (item && !this.current) this.replace(item);
  }

  private replace(item: Featured) {
    if (this.current && sameFeatured(this.current, item)) return;
    this.current = item;
    for (const listener of this.listeners) listener();
  }

  dispose() {
    clearTimeout(this.timer);
  }
}

export function useFeatured(store: FeaturedStore): Featured | null {
  return useSyncExternalStore(store.subscribe, store.get);
}
