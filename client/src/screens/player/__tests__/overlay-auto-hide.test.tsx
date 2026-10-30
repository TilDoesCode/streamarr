import { act, screen } from '@testing-library/react-native';
import { createRef } from 'react';
import { Platform } from 'react-native';

import i18n from '@/i18n';
import type { PlaybackController } from '@/player/controller';
import { renderWithProviders } from '@/../jest/render';

import { PlayerOverlay } from '../player-overlay';

jest.mock('@modules/player-keys', () => ({
  playerKeysAvailable: true,
  setKeyCapture: jest.fn(),
  addKeyListener: () => ({ remove: () => undefined }),
}));
jest.mock('expo-video', () => ({ VideoAirPlayButton: () => null }));
jest.mock('@/player/engines', () => ({ ENGINE_LABELS: {} }));

function controller() {
  return {
    engine: {
      getSnapshot: () => ({ state: 'playing', tracks: { audio: [], subtitles: [] } }),
      Surface: null,
    },
    playback: { method: 'direct', mediaInfo: { audioTracks: [], subtitleTracks: [] } },
    preferences: {},
    paused: false,
    phase: 'playing',
    position: 10,
    duration: 600,
    pictureInPicture: false,
    currentAudio: () => null,
    currentSubtitle: () => null,
    renditionOf: () => undefined,
    seekTo: jest.fn(),
    seekBy: jest.fn(),
    togglePlay: jest.fn(),
    setPaused: jest.fn(),
  } as unknown as PlaybackController;
}

const hidden = () =>
  screen.queryByTestId('player-overlay-hidden', { includeHiddenElements: true }) !== null;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('player overlay on TV (owner, 2026-10-30)', () => {
  it('hides by itself 5 s after the picture runs, and Back first hides it before the player may leave', async () => {
    const backRef = createRef<(() => boolean) | null>();
    await renderWithProviders(
      <PlayerOverlay
        controller={controller()}
        clock={{ position: 10, duration: 600, buffered: 60 }}
        title="Sintel"
        suspended={false}
        onPanel={jest.fn()}
        onClose={jest.fn()}
        backRef={backRef}
      />
    );
    expect(hidden()).toBe(false);
    await act(async () => jest.advanceTimersByTime(4_900));
    expect(hidden()).toBe(false);
    await act(async () => jest.advanceTimersByTime(200));
    expect(hidden()).toBe(true);
    // Hidden: Back is not the overlay's any more, the screen leaves.
    expect(backRef.current?.()).toBe(false);
  });

  it("Back while the overlay shows only hides it; the next Back is the screen's", async () => {
    const backRef = createRef<(() => boolean) | null>();
    await renderWithProviders(
      <PlayerOverlay
        controller={controller()}
        clock={{ position: 10, duration: 600, buffered: 60 }}
        title="Sintel"
        suspended={false}
        onPanel={jest.fn()}
        onClose={jest.fn()}
        backRef={backRef}
      />
    );
    let first = false;
    await act(async () => void (first = backRef.current?.() ?? false));
    expect(first).toBe(true);
    expect(hidden()).toBe(true);
    expect(backRef.current?.()).toBe(false);
  });
});
