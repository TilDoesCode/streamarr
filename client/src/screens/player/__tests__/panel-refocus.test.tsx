import { act, fireEvent, screen } from '@testing-library/react-native';
import { createRef } from 'react';
import { Platform } from 'react-native';

import i18n from '@/i18n';
import { tvFocus } from '@/components/focus/tv-focus';
import type { PlaybackController } from '@/player/controller';
import { renderWithProviders } from '@/../jest/render';

import { PlayerOverlay } from '../player-overlay';
import type { PanelKind } from '../player-panels';

jest.mock('@modules/player-keys', () => ({
  playerKeysAvailable: true,
  setKeyCapture: jest.fn(),
  addKeyListener: () => ({ remove: () => undefined }),
}));
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
  playback: {
    method: 'direct',
    mediaInfo: {
      audioTracks: [{ index: 1, language: 'ger', codec: 'ac3', channels: 6 }],
      subtitleTracks: [{ index: 2, language: 'ger', codec: 'subrip' }],
    },
  },
  preferences: {},
  paused: false,
  phase: 'playing',
  position: 52,
  duration: 600,
  pictureInPicture: false,
  currentAudio: () => 1,
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

async function overlay(onPanel = jest.fn()) {
  const refocusRef = createRef<((target?: PanelKind) => void) | null>();
  await renderWithProviders(
    <PlayerOverlay
      controller={controller}
      clock={{ position: 52, duration: 600, buffered: 60 }}
      title="Big Buck Bunny"
      suspended={false}
      onPanel={onPanel}
      onClose={jest.fn()}
      backRef={createRef()}
      refocusRef={refocusRef}
    />
  );
  // The overlay's own entry focus (Play) is not under test.
  (tvFocus as jest.Mock).mockClear();
  return refocusRef;
}

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

beforeEach(() => (tvFocus as jest.Mock).mockClear());
afterEach(() => jest.restoreAllMocks());

describe('closing an inline panel on Android TV (build 14: focus landed on the seek bar)', () => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
  });

  it('focuses the chip that opened the panel, so the next ◀/▶ moves along the row instead of seeking', async () => {
    const onPanel = jest.fn();
    const refocus = await overlay(onPanel);
    await fireEvent.press(screen.getByTestId('player-open-subtitles'));
    expect(onPanel).toHaveBeenCalledWith('subtitles');
    (tvFocus as jest.Mock).mockClear();

    await act(() => refocus.current?.());
    expect(focusedIds()).toEqual(['player-open-subtitles']);
  });

  it('refocuses the pressed chip once: a later close without a chip press goes to Play, not the old chip', async () => {
    const refocus = await overlay();
    await fireEvent.press(screen.getByTestId('player-open-audio'));
    await act(() => refocus.current?.());
    (tvFocus as jest.Mock).mockClear();
    await act(() => refocus.current?.());
    expect(focusedIds()).toEqual(['player-toggle']);
  });

  it("closing a hint's version picker focuses the version chip, not the seek bar", async () => {
    const refocus = await overlay();
    expect(screen.getByTestId('player-open-version')).toBeOnTheScreen();
    await act(() => refocus.current?.('version'));
    expect(focusedIds()).toEqual(['player-open-version']);
  });

  it('a close with no known chip (hint panel, hidden chip) leaves focus on Play in the row', async () => {
    const refocus = await overlay();
    await act(() => refocus.current?.());
    expect(focusedIds()).toEqual(['player-toggle']);
  });
});

it('phones and the web keep their focus handling (no TV refocus)', async () => {
  jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(false);
  const refocus = await overlay();
  await fireEvent.press(screen.getByTestId('player-open-audio'));
  (tvFocus as jest.Mock).mockClear();
  await act(() => refocus.current?.());
  expect(tvFocus).not.toHaveBeenCalled();
});
