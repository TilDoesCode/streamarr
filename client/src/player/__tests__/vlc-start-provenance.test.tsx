import { act, render } from '@testing-library/react-native';
import type { LibVlcPlayerView } from 'expo-libvlc-player';
import type { ComponentProps } from 'react';

import { harness, newController, reply } from '@/../jest/player/harness';
import { settle, TICKS } from '@/../jest/player/play';
import type { PlaybackController } from '@/player/controller';

let mockNative: ComponentProps<typeof LibVlcPlayerView>;
jest.mock('expo-libvlc-player', () => ({
  LibVlcPlayerView: (props: ComponentProps<typeof LibVlcPlayerView>) => {
    mockNative = props;
    return null;
  },
}));
jest.mock('@/player/engines', () => ({
  createEngine: () => new (jest.requireActual('@/player/engines/vlc-engine').VlcEngine)(),
  vlcAvailable: () => true,
  streamyboxAvailable: () => false,
}));

beforeEach(() => {
  harness.reset();
  jest.useFakeTimers();
});
afterEach(() => jest.useRealTimers());

/** The real VLC adapter under the controller, a stream resumed at 100 s (or "From the beginning"). */
async function started(fromStart: boolean) {
  harness.server.answer(
    'start',
    reply.ok(harness.server.playback({ engine: 'vlc', resumePositionTicks: 100 * TICKS } as never))
  );
  const player = newController({ startSeconds: undefined });
  const starting = player.start();
  await settle();
  player.chooseStart(!fromStart);
  await starting;
  const Surface = player.engine!.Surface;
  const mounted = await render(<Surface style={{ flex: 1 }} />);
  return { player, mounted };
}

/** Every position the stream reported to the server (start, progress, stop). */
const positions = () =>
  harness.server.sent('progress').map((request) => Number(request.body?.positionTicks) / TICKS);

async function stopped(player: PlaybackController, mounted: { unmount(): unknown }) {
  await act(() => player.stop());
  await mounted.unmount();
}

/** libVLC on first Playing with a known length (Android and iOS): `onFirstPlay` comes before any time report. */
const firstPlay = () => {
  mockNative.onPlaying?.();
  mockNative.onFirstPlay?.({
    media: { length: 600_000 },
    video: { width: 1920, height: 1080 },
  } as never);
};

/** DL-C-verify5 C5-02: libVLC's duration metadata republishes the requested start; it is no observed clock. */
describe('VLC start provenance: only observed clock readings land a start', () => {
  it.each([
    ['Resume', false],
    ['From the beginning', true],
  ])(
    '%s: duration metadata, then a stale 400 never becomes the resume point',
    async (_choice, fromStart) => {
      const { player, mounted } = await started(fromStart);
      const target = fromStart ? 0 : 100;
      await act(async () => {
        firstPlay();
        // The first real time report: an old clock far from the target.
        mockNative.onTimeChanged?.({ value: 400_000 } as never);
      });
      await jest.advanceTimersByTimeAsync(10_000);
      expect(player.resumePosition).toBe(target);
      expect(player.duration).toBe(600);
      expect(positions().filter((position) => position > target + 3)).toEqual([]);
      await stopped(player, mounted);
      expect(positions().filter((position) => position > target + 3)).toEqual([]);
    }
  );

  it('an accurate start still opens at its first real reading', async () => {
    const { player, mounted } = await started(false);
    await act(async () => {
      firstPlay();
      mockNative.onTimeChanged?.({ value: 100_400 } as never);
    });
    expect(player.resumePosition).toBe(100.4);
    await jest.advanceTimersByTimeAsync(10_000);
    await stopped(player, mounted);
    expect(positions().length).toBeGreaterThan(0);
    expect(positions().every((position) => Math.abs(position - 100.4) <= 3)).toBe(true);
  });

  it('readings libVLC reports below the start before it lands show the start, never land it', async () => {
    const { player, mounted } = await started(false);
    await act(async () => {
      firstPlay();
      // The start seek not applied yet: libVLC plays from 0; the adapter shows the start meanwhile.
      mockNative.onTimeChanged?.({ value: 1_000 } as never);
    });
    expect(player.engine!.getSnapshot().position).toBe(100);
    await act(async () => {
      jest.advanceTimersByTime(1_000);
      mockNative.onTimeChanged?.({ value: 400_000 } as never);
    });
    await jest.advanceTimersByTimeAsync(10_000);
    expect(player.resumePosition).toBe(100);
    await stopped(player, mounted);
    expect(positions().filter((position) => position > 103)).toEqual([]);
  });
});

/** The same with a download (the real VLC adapter on a local file), resumed at 100 s or "From the beginning". */
describe('VLC start provenance on a download', () => {
  async function download(fromStart: boolean) {
    const reported: number[] = [];
    const player = newController({
      startSeconds: undefined,
      onPosition: (position) => reported.push(position),
      local: {
        downloadId: 'vlc-gate',
        uri: 'file:///private/Movie.mkv',
        engine: 'vlc',
        resumeSeconds: 100,
        releaseId: 'r',
        version: null,
        mediaInfo: { durationTicks: 600 * TICKS, audioTracks: [], subtitleTracks: [] },
        offline: () => false,
      },
    });
    const starting = player.start();
    await settle();
    player.chooseStart(!fromStart);
    await starting;
    const Surface = player.engine!.Surface;
    const mounted = await render(<Surface style={{ flex: 1 }} />);
    return { player, reported, mounted };
  }

  it.each([
    ['Resume', false],
    ['From the beginning', true],
  ])(
    '%s: duration metadata, then a stale 400 is never saved or reported',
    async (_choice, fromStart) => {
      const { player, reported, mounted } = await download(fromStart);
      const target = fromStart ? 0 : 100;
      await act(async () => {
        firstPlay();
        mockNative.onTimeChanged?.({ value: 400_000 } as never);
      });
      await jest.advanceTimersByTimeAsync(10_000);
      expect(player.resumePosition).toBe(target);
      await stopped(player, mounted);
      expect(reported.filter((position) => position > target + 3)).toEqual([]);
    }
  );

  it('an accurate start still counts at its first real reading', async () => {
    const { player, reported, mounted } = await download(false);
    await act(async () => {
      firstPlay();
      mockNative.onTimeChanged?.({ value: 100_400 } as never);
    });
    expect(player.resumePosition).toBe(100.4);
    await stopped(player, mounted);
    expect(reported.length).toBeGreaterThan(0);
    expect(reported.every((position) => Math.abs(position - 100.4) <= 3)).toBe(true);
  });

  it('readings below the start before it lands never land it', async () => {
    const { player, reported, mounted } = await download(false);
    await act(async () => {
      firstPlay();
      mockNative.onTimeChanged?.({ value: 1_000 } as never);
    });
    await act(async () => {
      jest.advanceTimersByTime(1_000);
      mockNative.onTimeChanged?.({ value: 400_000 } as never);
    });
    await jest.advanceTimersByTimeAsync(10_000);
    expect(player.resumePosition).toBe(100);
    await stopped(player, mounted);
    expect(reported.filter((position) => position > 103)).toEqual([]);
  });
});
