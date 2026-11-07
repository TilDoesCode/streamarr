import { deviceSettings } from '@/lib/storage';

/** Below this the `Date` header's one-second resolution and the request's travel time are noise. */
export const CLOCK_SKEW_THRESHOLD_MS = 5_000;
const KEY = 'serverClockSkewMs';

type SkewStorage = {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
};

let storage: SkewStorage = deviceSettings;
let skewMs: number | null = null;

function stored(): number {
  const value = Number(storage.getString(KEY) ?? '0');
  return Number.isFinite(value) ? value : 0;
}

/** Learns how far this device's clock is off from a server answer's `Date` header (kept for offline starts). */
export function noteServerDate(date: string | null | undefined, receivedAt = Date.now()): void {
  const at = date ? Date.parse(date) : NaN;
  if (!Number.isFinite(at)) return;
  const measured = at - receivedAt;
  const next = Math.abs(measured) < CLOCK_SKEW_THRESHOLD_MS ? 0 : measured;
  const previous = skewMs ?? stored();
  skewMs = next;
  if (Math.abs(next - previous) >= 2_000 || (next === 0) !== (previous === 0))
    storage.set(KEY, String(next));
}

/** `at` (default now) on the server's clock: offline progress and positions compare with other devices by it. */
export function serverNow(at = Date.now()): number {
  skewMs ??= stored();
  return at + skewMs;
}

/** Tests: a fresh clock over `next` storage. */
export function resetServerClock(next: SkewStorage = deviceSettings): void {
  storage = next;
  skewMs = null;
}
