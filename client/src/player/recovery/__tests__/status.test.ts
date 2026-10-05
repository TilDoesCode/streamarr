import { statusOf, type StatusInput } from '@/player/recovery/status';
import type { Recovery } from '@/player/recovery/runner';

const base: StatusInput = {
  now: 10_000,
  phase: 'playing',
  offline: false,
  recovery: null,
  loadingSince: 0,
  stallSince: 0,
  seekAt: 0,
  seeking: false,
  paused: false,
  systemPaused: false,
  autoplay: null,
  health: null,
  frozenAt: 0,
  serverState: '',
  serverStateSince: 0,
  method: 'remux',
  bitrateKbps: undefined,
  bandwidthBps: undefined,
};

describe('statusOf', () => {
  it('a waiting step never counts down to 0 s, even when its timer fires late (review K27)', () => {
    const recovery = {
      decision: { step: 'R', delayMs: 5_000, hint: 'serverError' },
      failure: { category: 'T6', code: 'segment_unavailable' },
      extra: {},
      position: 100,
      tracks: { audio: null, subtitle: null },
      due: 9_800,
      running: false,
      timer: null,
    } as Recovery;
    expect(statusOf({ ...base, recovery }).hint?.params).toMatchObject({ seconds: 1 });
  });
});
