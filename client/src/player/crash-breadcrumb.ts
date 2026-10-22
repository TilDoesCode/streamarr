import { getExitHistoryAsync, type ExitRecord } from '@modules/media-caps';

import { deviceSettings } from '@/lib/storage';

/** The playback that was showing a picture; still set at the next start = the process died during it. */
export type RunningPlayback = {
  workId: string;
  releaseId?: string;
  /** Source video height (2160 for a 4K version). */
  height?: number;
  /** Epoch ms when it started playing. */
  at: number;
};

export type CrashedPlayback = RunningPlayback & { reason: string; description?: string | null };

const KEY = 'player.running';
/** Exit reasons that mean the app died, not that the viewer or the OS closed it on purpose. */
const CRASHES: ReadonlySet<string> = new Set([
  'crash',
  'crashNative',
  'anr',
  'lowMemory',
  'signaled',
  'excessiveResourceUsage',
  'initializationFailure',
]);
/** ActivityManager importance up to "visible": the app was on screen, not killed in the background. */
const ON_SCREEN = 200;
/** Above this height a crashed version plays as the server's 1080p conversion next time. */
export const SAFE_HEIGHT = 1080;

export function markPlaybackRunning(playback: RunningPlayback): void {
  deviceSettings.set(KEY, JSON.stringify(playback));
}

export function clearPlaybackRunning(): void {
  deviceSettings.remove(KEY);
}

function readRunning(): RunningPlayback | null {
  try {
    const raw = deviceSettings.getString(KEY);
    const value = raw ? (JSON.parse(raw) as Partial<RunningPlayback>) : null;
    return value?.workId && typeof value.at === 'number' ? (value as RunningPlayback) : null;
  } catch {
    return null;
  }
}

/** The playback the last process died in (Android's own exit record confirms it), once; null otherwise. */
export async function takeCrashedPlayback(
  readExits: (max: number) => Promise<ExitRecord[]> = getExitHistoryAsync
): Promise<CrashedPlayback | null> {
  const running = readRunning();
  if (!running) return null;
  clearPlaybackRunning();
  const exits = await readExits(5).catch(() => [] as ExitRecord[]);
  const exit = exits.find(
    (record) =>
      record.time >= running.at && CRASHES.has(record.reason) && record.importance <= ON_SCREEN
  );
  if (!exit) return null;
  if (__DEV__) console.warn('[player] the app died during a playback', exit);
  return { ...running, reason: exit.reason, description: exit.description };
}

/** A version that crashed the app plays as a lower conversion this time (the viewer can still pick another quality). */
export function safeMaxHeight(
  crashed: CrashedPlayback | null,
  workId: string,
  releaseId?: string
): number | undefined {
  if (!crashed || crashed.workId !== workId) return undefined;
  if (releaseId && crashed.releaseId && releaseId !== crashed.releaseId) return undefined;
  return (crashed.height ?? 0) > SAFE_HEIGHT ? SAFE_HEIGHT : undefined;
}
