import type { ExitRecord } from '@modules/media-caps';

import {
  clearPlaybackRunning,
  markPlaybackRunning,
  safeMaxHeight,
  takeCrashedPlayback,
} from '../crash-breadcrumb';

const exit = (over: Partial<ExitRecord>): ExitRecord => ({
  time: 2_000,
  reason: 'crash',
  status: 0,
  importance: 100,
  ...over,
});

describe('crash breadcrumb', () => {
  beforeEach(() => {
    clearPlaybackRunning();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('finds a 4K playback the app died in and plays it as 1080p next time, once', async () => {
    markPlaybackRunning({ workId: 'w1', releaseId: 'uhd', height: 2160, at: 1_000 });
    const crashed = await takeCrashedPlayback(async () => [exit({ reason: 'lowMemory' })]);
    expect(crashed).toMatchObject({ workId: 'w1', releaseId: 'uhd', reason: 'lowMemory' });
    expect(safeMaxHeight(crashed, 'w1', 'uhd')).toBe(1080);
    expect(safeMaxHeight(crashed, 'w1')).toBe(1080);
    expect(safeMaxHeight(crashed, 'w1', 'other')).toBeUndefined();
    expect(safeMaxHeight(crashed, 'w2')).toBeUndefined();
    expect(await takeCrashedPlayback(async () => [exit({})])).toBeNull();
  });

  it('ignores ends the viewer or the OS meant, background kills and older exits', async () => {
    const cases: ExitRecord[] = [
      exit({ reason: 'userRequested' }),
      exit({ reason: 'exitSelf' }),
      exit({ reason: 'lowMemory', importance: 400 }),
      exit({ reason: 'crash', time: 500 }),
    ];
    for (const record of cases) {
      markPlaybackRunning({ workId: 'w1', height: 2160, at: 1_000 });
      expect(await takeCrashedPlayback(async () => [record])).toBeNull();
    }
  });

  it('keeps 1080p versions as they are and survives a failing exit read', async () => {
    markPlaybackRunning({ workId: 'w1', height: 1080, at: 1_000 });
    const crashed = await takeCrashedPlayback(async () => [exit({ reason: 'crashNative' })]);
    expect(safeMaxHeight(crashed, 'w1')).toBeUndefined();
    markPlaybackRunning({ workId: 'w1', height: 2160, at: 1_000 });
    expect(await takeCrashedPlayback(() => Promise.reject(new Error('no api')))).toBeNull();
  });

  it('has nothing to report after a clean end', async () => {
    markPlaybackRunning({ workId: 'w1', height: 2160, at: 1_000 });
    clearPlaybackRunning();
    expect(await takeCrashedPlayback(async () => [exit({})])).toBeNull();
  });
});
