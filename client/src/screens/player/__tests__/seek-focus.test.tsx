import { act, screen } from '@testing-library/react-native';
import { createRef } from 'react';
import { Platform } from 'react-native';

import i18n from '@/i18n';
import { tvFocus } from '@/components/focus/tv-focus';
import type { PlaybackController } from '@/player/controller';
import type { Clock } from '@/player/use-clock';
import { renderWithProviders } from '@/../jest/render';

import { PlayerOverlay } from '../player-overlay';

type TVEvent = { eventType: string; eventKeyAction?: number };
const mockTV = { listeners: new Set<(event: TVEvent) => void>() };
const mockKeys = {
  listener: null as ((event: { key: string; repeat: number }) => void) | null,
  capture: [] as string[],
};

jest.mock('@modules/player-keys', () => ({
  playerKeysAvailable: true,
  setKeyCapture: (groups: string[]) => {
    mockKeys.capture = groups;
  },
  addKeyListener: (listener: (event: { key: string; repeat: number }) => void) => {
    mockKeys.listener = listener;
    return { remove: () => undefined };
  },
}));
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return Object.defineProperty(actual, 'useTVEventHandler', {
    value: (listener: (event: TVEvent) => void) => {
      mockTV.listeners.add(listener);
    },
  });
});
jest.mock('expo-video', () => ({ VideoAirPlayButton: () => null }));
jest.mock('@/player/engines', () => ({ ENGINE_LABELS: {} }));
jest.mock('@/components/focus/tv-focus', () => ({
  ...jest.requireActual('@/components/focus/tv-focus'),
  tvFocus: jest.fn(),
}));

const controller = {
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
} as unknown as PlaybackController;

const focusedIds = () =>
  (tvFocus as jest.Mock).mock.calls.map(
    ([target]) => (target as { props?: { testID?: string } } | null)?.props?.testID
  );

/** Native player-keys press (only the key-down reaches JS) while the D-pad is captured. */
const capturedKey = (key: string) => act(async () => mockKeys.listener?.({ key, repeat: 0 }));
/** A react-native-tvos key event as Android reports it (0 = down, 1 = up). */
const tvKey = (eventType: string, eventKeyAction: number) =>
  act(async () => mockTV.listeners.forEach((listener) => listener({ eventType, eventKeyAction })));

function overlay(clock: Clock) {
  return (
    <PlayerOverlay
      controller={controller}
      clock={clock}
      title="Big Buck Bunny"
      suspended={false}
      onPanel={jest.fn()}
      onClose={jest.fn()}
      backRef={createRef()}
    />
  );
}

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

beforeEach(() => {
  (tvFocus as jest.Mock).mockClear();
  jest.replaceProperty(Platform, 'OS', 'android');
  jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
});
afterEach(() => jest.restoreAllMocks());

describe('Android TV: focus leaves the seek bar (ROCK 4D: "kriegt man den Fokus da nicht mehr runter")', () => {
  it('▼ from the seek bar lands on the row and its key-up does not pull focus back', async () => {
    const view = await renderWithProviders(overlay({ position: 52, duration: 600, buffered: 60 }));
    // ▼ on the row (native focus, nothing below): down + up reach React Native and move to the seek bar.
    await tvKey('down', 0);
    await tvKey('down', 1);
    expect(focusedIds().at(-1)).toBe('player-seek');
    expect(mockKeys.capture).toContain('dpad');

    // ▼ on the seek bar: player-keys takes the key-down, the key-up still reaches React Native.
    (tvFocus as jest.Mock).mockClear();
    await capturedKey('down');
    await tvKey('down', 1);
    expect(focusedIds()).not.toContain('player-seek');
    expect(focusedIds().at(-1)).toBe('player-toggle');
    expect(mockKeys.capture).not.toContain('dpad');

    // Progress updates afterwards never move focus.
    (tvFocus as jest.Mock).mockClear();
    for (let second = 53; second < 58; second++)
      await view.rerender(overlay({ position: second, duration: 600, buffered: second + 20 }));
    expect(tvFocus).not.toHaveBeenCalled();
    expect(screen.getByTestId('player-overlay')).toBeOnTheScreen();
  });

  it('progress updates while the seek bar holds focus do not re-request focus', async () => {
    const view = await renderWithProviders(overlay({ position: 52, duration: 600, buffered: 60 }));
    await tvKey('down', 0);
    await tvKey('down', 1);
    (tvFocus as jest.Mock).mockClear();
    for (let second = 53; second < 58; second++)
      await view.rerender(overlay({ position: second, duration: 600, buffered: second + 20 }));
    expect(tvFocus).not.toHaveBeenCalled();
  });

  it('▲ from the seek bar also lands on the row', async () => {
    await renderWithProviders(overlay({ position: 52, duration: 600, buffered: 60 }));
    await tvKey('down', 0);
    await tvKey('down', 1);
    (tvFocus as jest.Mock).mockClear();
    await capturedKey('up');
    await tvKey('up', 1);
    expect(focusedIds()).not.toContain('player-seek');
    expect(focusedIds().at(-1)).toBe('player-toggle');
  });
});
