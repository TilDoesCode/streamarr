import { act, screen } from '@testing-library/react-native';
import { createRef } from 'react';

import i18n from '@/i18n';
import type { PlaybackController } from '@/player/controller';
import { renderWithProviders } from '@/../jest/render';

import { PlayerOverlay } from '../player-overlay';

const mockKeys = { listener: null as ((event: { key: string; repeat: number }) => void) | null };
jest.mock('@modules/player-keys', () => ({
  playerKeysAvailable: true,
  setKeyCapture: jest.fn(),
  addKeyListener: (listener: (event: { key: string; repeat: number }) => void) => {
    mockKeys.listener = listener;
    return { remove: () => undefined };
  },
}));
jest.mock('expo-video', () => ({ VideoAirPlayButton: () => null }));
jest.mock('@/player/engines', () => ({ ENGINE_LABELS: {} }));

/** The engine is at 52 s while the coarse hidden clock still says 46 s (Google TV, S2). */
function fakeController() {
  return {
    engine: {
      getSnapshot: () => ({ state: 'playing', tracks: { audio: [], subtitles: [] } }),
      Surface: null,
    },
    playback: { method: 'direct', mediaInfo: { audioTracks: [], subtitleTracks: [] } },
    preferences: {},
    paused: false,
    phase: 'playing',
    position: 52,
    duration: 600,
    pictureInPicture: false,
    currentAudio: () => null,
    currentSubtitle: () => null,
    renditionOf: () => undefined,
    seekTo: jest.fn(),
    seekBy: jest.fn(),
    togglePlay: jest.fn(),
    setPaused: jest.fn(),
  } as unknown as PlaybackController & { seekTo: jest.Mock };
}

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

async function overlay(backRef = createRef<(() => boolean) | null>()) {
  const controller = fakeController();
  await renderWithProviders(
    <PlayerOverlay
      controller={controller}
      clock={{ position: 46, duration: 600, buffered: 60 }}
      title="Sherlock"
      suspended={false}
      onPanel={jest.fn()}
      onClose={jest.fn()}
      backRef={backRef}
    />
  );
  return controller;
}

describe('player overlay reads the live engine position (review S1)', () => {
  it('draws the first frame with the live time, not the coarse hidden clock', async () => {
    await overlay();
    expect(screen.getByTestId('player-position')).toHaveTextContent('0:52');
  });

  it('◀ scrubs from the live position', async () => {
    jest.useFakeTimers();
    const controller = await overlay();
    await act(async () => mockKeys.listener?.({ key: 'left', repeat: 0 }));
    expect(screen.getByTestId('player-position')).toHaveTextContent('0:42');
    await act(async () => jest.runOnlyPendingTimers());
    expect(controller.seekTo).toHaveBeenCalledWith(42);
    jest.useRealTimers();
  });

  it('a second Back before the re-render leaves the player instead of hiding again (S4b, Google TV)', async () => {
    const backRef = createRef<(() => boolean) | null>();
    await overlay(backRef);
    const steps = [backRef.current?.(), backRef.current?.()];
    expect(steps).toEqual([true, false]);
    await act(async () => undefined);
    await act(async () => mockKeys.listener?.({ key: 'down', repeat: 0 }));
    expect(backRef.current?.()).toBe(true);
  });
});
