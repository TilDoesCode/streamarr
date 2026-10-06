import { HealthMonitor } from '@/player/health/monitor';
import type { EngineHealth } from '@/player/health/types';

afterEach(() => jest.useRealTimers());

/** A playing engine whose clock stands at 0:10 and whose probe answers with `readHealth`. */
function monitorWith(readHealth: () => Promise<EngineHealth>) {
  const snapshot = {
    state: 'playing',
    position: 10,
    duration: 100,
    buffered: 0,
    tracks: { audio: [], subtitles: [] },
    stats: {},
  };
  const probe = jest.fn(readHealth);
  const engine = { kind: 'expo-video', getSnapshot: () => snapshot, readHealth: probe } as never;
  const stall = jest.fn();
  const changed = jest.fn();
  const monitor = new HealthMonitor({
    engine: () => engine,
    closed: () => false,
    context: () => ({
      wantsPlayback: true,
      visible: true,
      pictureInPicture: false,
      settling: false,
      hasVideo: true,
      hasAudio: true,
      buffering: false,
    }),
    stall,
    escalate: jest.fn(),
    changed,
  });
  return { monitor, stall, probe, changed };
}

describe('health monitor: a native probe that never answers (code review native #3)', () => {
  it('a frozen clock with an answering probe joins the stall timeline', async () => {
    jest.useFakeTimers();
    const { monitor, stall } = monitorWith(async () => ({}));
    monitor.start();
    await jest.advanceTimersByTimeAsync(8_000);
    expect(stall).toHaveBeenCalled();
    monitor.stop();
  });

  it('a probe that never answers does not switch the clock rule off', async () => {
    jest.useFakeTimers();
    const { monitor, stall } = monitorWith(() => new Promise(() => undefined));
    monitor.start();
    await jest.advanceTimersByTimeAsync(8_000);
    expect(stall).toHaveBeenCalled();
    monitor.stop();
  });

  it('a probe that keeps timing out counts as no probe until the next source', async () => {
    jest.useFakeTimers();
    const { monitor, probe } = monitorWith(() => new Promise(() => undefined));
    monitor.start();
    await jest.advanceTimersByTimeAsync(20_000);
    const asked = probe.mock.calls.length;
    expect(asked).toBeLessThanOrEqual(3);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(probe).toHaveBeenCalledTimes(asked);
    monitor.newSource();
    await jest.advanceTimersByTimeAsync(2_000);
    expect(probe.mock.calls.length).toBeGreaterThan(asked);
    monitor.stop();
  });

  it('a slow probe that answers in time is read', async () => {
    jest.useFakeTimers();
    const { monitor } = monitorWith(
      () => new Promise((resolve) => setTimeout(() => resolve({ framesPresented: 7 }), 900))
    );
    monitor.start();
    await jest.advanceTimersByTimeAsync(2_500);
    expect(monitor.last).toEqual({ framesPresented: 7 });
    monitor.stop();
  });
});
