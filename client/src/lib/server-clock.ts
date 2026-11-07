import { deviceSettings } from '@/lib/storage';

/** Below this the `Date` header's one-second resolution and the request's travel time are noise. */
export const CLOCK_SKEW_THRESHOLD_MS = 5_000;
/** An estimate (no anchor in this boot) may be off by the learned offset plus this. */
export const ESTIMATE_MARGIN_MS = 5 * 60_000;
/** The wall clock moved this far against the elapsed clock: it was set (NTP, by hand), not drifting. */
const WALL_JUMP_MS = 2_000;
const KEY = 'serverClocks';
const LEGACY_KEY = 'serverClockSkewMs';

type ClockStorage = {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  remove?(key: string): unknown;
};

/** Monotonic time since boot (sleep-inclusive) and the boot it counts from. */
export type ElapsedClock = { elapsedMs: number; bootId: string };
/** A time on a server's clock; `estimated` when no anchor of this boot backs it (± `uncertaintyMs`). */
export type ServerStamp = { at: number; estimated: boolean; uncertaintyMs: number };
type Anchor = { offset: number; wallAt: number; elapsedAt: number; bootId: string };

const processBoot = `p${Math.random().toString(36).slice(2, 12)}`;
const processClock = (): ElapsedClock => ({ elapsedMs: performance.now(), bootId: processBoot });

let storage: ClockStorage = deviceSettings;
let anchors: Map<string, Anchor> | null = null;
let elapsedSource: (() => ElapsedClock | null) | null = null;

/** The engine's elapsed clock (DL-N); null or a null answer falls back to this process's `performance.now()`. */
export function setElapsedClock(source: (() => ElapsedClock | null) | null): void {
  elapsedSource = source;
}

function elapsed(): ElapsedClock {
  try {
    return elapsedSource?.() ?? processClock();
  } catch {
    return processClock();
  }
}

function load(): Map<string, Anchor> {
  if (anchors) return anchors;
  anchors = new Map();
  try {
    const saved = JSON.parse(storage.getString(KEY) ?? '{}') as Record<string, Anchor>;
    for (const [server, anchor] of Object.entries(saved))
      if (Number.isFinite(anchor?.offset)) anchors.set(server, anchor);
  } catch {
    anchors.clear();
  }
  storage.remove?.(LEGACY_KEY);
  return anchors;
}

function persist(all: Map<string, Anchor>): void {
  storage.set(KEY, JSON.stringify(Object.fromEntries(all)));
}

/** `server` (a `serverKey`) part of a download account key (`server#viewer`). */
export function serverOfAccountKey(accountKey: string): string {
  const hash = accountKey.indexOf('#');
  return hash < 0 ? accountKey : accountKey.slice(0, hash);
}

/** Learns how far this device's clock is off from `server`'s answer `Date` header (kept for offline starts). */
export function noteServerDate(
  server: string,
  date: string | null | undefined,
  receivedAt = Date.now()
): void {
  const at = date ? Date.parse(date) : NaN;
  if (!Number.isFinite(at)) return;
  const measured = at - receivedAt;
  const offset = Math.abs(measured) < CLOCK_SKEW_THRESHOLD_MS ? 0 : measured;
  const clock = elapsed();
  const all = load();
  const previous = all.get(server);
  all.set(server, { offset, wallAt: Date.now(), elapsedAt: clock.elapsedMs, bootId: clock.bootId });
  if (
    !previous ||
    previous.bootId !== clock.bootId ||
    Math.abs(offset - previous.offset) >= 2_000 ||
    (offset === 0) !== (previous.offset === 0)
  )
    persist(all);
}

/** `at` (default now) on `server`'s clock; exact within the boot it was learned in, whatever the wall clock does. */
export function serverStamp(server: string | null | undefined, at = Date.now()): ServerStamp {
  const anchor = server ? load().get(server) : undefined;
  if (!anchor) return { at, estimated: true, uncertaintyMs: ESTIMATE_MARGIN_MS };
  const clock = elapsed();
  const sinceAnchor = clock.elapsedMs - anchor.elapsedAt;
  if (anchor.bootId !== clock.bootId || !Number.isFinite(anchor.wallAt) || !(sinceAnchor >= 0))
    return {
      at: at + anchor.offset,
      estimated: true,
      uncertaintyMs: Math.abs(anchor.offset) + ESTIMATE_MARGIN_MS,
    };
  const drift = Date.now() - anchor.wallAt - sinceAnchor;
  const wall = Math.abs(drift) > WALL_JUMP_MS ? at - drift : at;
  return { at: wall + anchor.offset, estimated: false, uncertaintyMs: 0 };
}

/** `at` (default now) on `server`'s clock: offline progress and positions compare with other devices by it. */
export function serverNow(server: string | null | undefined, at?: number): number {
  return serverStamp(server, at).at;
}

/** Tests: a fresh clock over `next` storage. */
export function resetServerClock(next: ClockStorage = deviceSettings): void {
  storage = next;
  anchors = null;
}
