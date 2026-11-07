import { createMemoryDownloadsStorage } from '@/downloads/store';
import type { LocalPosition } from '@/downloads/types';
import { ESTIMATE_MARGIN_MS, resetServerClock, setElapsedClock } from '@/lib/server-clock';

import { createTestDownloads, TEST_ACCOUNT_KEY } from '../../../jest/downloads';
import { resumeSecondsOf } from '../local-play';

const MINUTE = 60_000;
const NOW = Date.parse('2026-11-07T12:00:00Z');
const MOVIE = 'tmdb-movie-603';

const local = (patch: Partial<LocalPosition> = {}): LocalPosition => ({
  seconds: 100,
  durationSeconds: 600,
  at: NOW,
  played: false,
  estimated: true,
  uncertaintyMs: ESTIMATE_MARGIN_MS,
  ...patch,
});

afterEach(() => {
  setElapsedClock(null);
  resetServerClock(createMemoryDownloadsStorage());
});

describe('resume position: an estimated local stamp against the server (C2-06/C2-07)', () => {
  it('inside the uncertainty window the larger position wins, whichever stamp is newer', () => {
    expect(resumeSecondsOf(local(), { seconds: 300, at: NOW - 2 * MINUTE })).toBe(300);
    expect(resumeSecondsOf(local({ seconds: 400 }), { seconds: 300, at: NOW + 2 * MINUTE })).toBe(
      400
    );
    expect(resumeSecondsOf(local({ played: true }), { seconds: 300, at: NOW - MINUTE })).toBe(300);
  });

  it('an explicit restart wins inside the window (a few seconds in are the start, like on the server)', () => {
    const restarted = local({ seconds: 5, restarted: true });
    expect(resumeSecondsOf(restarted, { seconds: 300, at: NOW + 4 * MINUTE })).toBe(0);
  });

  it('outside the window the newer stamp wins as before', () => {
    expect(resumeSecondsOf(local(), { seconds: 50, at: NOW - 6 * MINUTE })).toBe(100);
    expect(resumeSecondsOf(local({ seconds: 400 }), { seconds: 50, at: NOW + 6 * MINUTE })).toBe(
      50
    );
    const wide = local({ uncertaintyMs: 2 * 60 * MINUTE });
    expect(resumeSecondsOf(wide, { seconds: 300, at: NOW - 60 * MINUTE })).toBe(300);
  });

  it('an exact (anchored) local stamp keeps the newer-wins rule', () => {
    const exact = local({ estimated: undefined, uncertaintyMs: undefined });
    expect(resumeSecondsOf(exact, { seconds: 300, at: NOW - MINUTE })).toBe(100);
    expect(resumeSecondsOf(exact, { seconds: 30, at: NOW + MINUTE })).toBe(30);
  });

  it('positions recorded after a reboot carry the estimate and the restart into the merge', () => {
    setElapsedClock(() => ({ elapsedMs: 1_000, bootId: 'boot-2' }));
    const test = createTestDownloads({ now: () => NOW });
    const later = test.manager.recordPosition(TEST_ACCOUNT_KEY, MOVIE, 120, 600);
    expect(later).toMatchObject({ estimated: true, uncertaintyMs: ESTIMATE_MARGIN_MS });
    expect(later.restarted).toBeUndefined();
    expect(resumeSecondsOf(later, { seconds: 200, at: NOW - MINUTE })).toBe(200);
    const over = test.manager.recordPosition(TEST_ACCOUNT_KEY, MOVIE, 10, 600, { restarted: true });
    expect(test.store.position(TEST_ACCOUNT_KEY, MOVIE)).toMatchObject({ restarted: true });
    expect(resumeSecondsOf(over, { seconds: 200, at: NOW - MINUTE })).toBe(0);
  });
});
