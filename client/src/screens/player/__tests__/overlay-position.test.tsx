import { act, fireEvent, screen } from '@testing-library/react-native';
import { createRef } from 'react';
import { Platform, StyleSheet } from 'react-native';

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
let mockWindow: { width: number; height: number; scale: number; fontScale: number } | undefined;
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => {
  const actual = jest.requireActual('react-native/Libraries/Utilities/useWindowDimensions');
  return { __esModule: true, default: () => mockWindow ?? actual.default() };
});
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

async function overlay(
  backRef = createRef<(() => boolean) | null>(),
  extra: { panel?: 'info' | 'audio' | null; title?: string } = {}
) {
  const controller = fakeController();
  await renderWithProviders(
    <PlayerOverlay
      controller={controller}
      clock={{ position: 46, duration: 600, buffered: 60 }}
      title={extra.title ?? 'Sherlock'}
      suspended={false}
      onPanel={jest.fn()}
      onClose={jest.fn()}
      backRef={backRef}
      panel={extra.panel ?? null}
    />
  );
  return controller;
}

describe('the large header title and an open side panel (Q2-01, web 1280)', () => {
  afterEach(() => {
    mockWindow = undefined;
  });
  const long = 'Sherlock · S2, E2 · Die Hunde von Baskerville';
  const s = (value: number) => Math.round(value * Math.max(0.6, 1280 / 1920) * 2) / 2;
  const maxWidth = () =>
    StyleSheet.flatten(screen.getByTestId('player-title').props.style).maxWidth as number | string;

  it.each([
    ['info', 700],
    ['audio', 520],
  ] as const)('with the %s panel open the title ends before the panel', async (panel, width) => {
    mockWindow = { width: 1280, height: 800, scale: 2, fontScale: 1 };
    await overlay(undefined, { panel, title: long });
    const panelLeft = 1280 - s(64) - s(width);
    expect(typeof maxWidth()).toBe('number');
    expect(s(96) + (maxWidth() as number)).toBeLessThanOrEqual(panelLeft);
  });

  it('without a panel the title keeps its 80 %', async () => {
    mockWindow = { width: 1280, height: 800, scale: 2, fontScale: 1 };
    await overlay(undefined, { title: long });
    expect(maxWidth()).toBe('80%');
  });
});

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

describe('hidden player controls leave the screen on touch shells (Q1-46, verify V1)', () => {
  const display = () =>
    StyleSheet.flatten(
      screen.getByTestId(/^player-overlay/, { includeHiddenElements: true }).props.style
    ).display ?? 'flex';

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('phone/tablet: the hidden overlay is removed after the fade and comes back when shown', async () => {
    const backRef = createRef<(() => boolean) | null>();
    await overlay(backRef);
    await act(async () => void backRef.current?.());
    expect(screen.getByTestId('player-overlay-hidden')).toBeTruthy();
    await act(async () => jest.advanceTimersByTime(300));
    expect(display()).not.toBe('none');
    await act(async () => jest.advanceTimersByTime(300));
    expect(display()).toBe('none');
    expect(screen.queryByTestId('player-close')).toBeNull();
    await act(async () => mockKeys.listener?.({ key: 'down', repeat: 0 }));
    expect(screen.getByTestId('player-overlay')).toBeTruthy();
    expect(display()).not.toBe('none');
  });

  it('TV keeps the faded overlay in the tree (hidden focus)', async () => {
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    const backRef = createRef<(() => boolean) | null>();
    await overlay(backRef);
    await act(async () => void backRef.current?.());
    await act(async () => jest.advanceTimersByTime(2000));
    expect(screen.getByTestId('player-overlay-hidden')).toBeTruthy();
    expect(display()).not.toBe('none');
  });
});

describe('a pause from outside the controls shows them (F8 V2: leaving the system full screen paused)', () => {
  it('shows the hidden overlay once the controller is paused', async () => {
    const controller = fakeController();
    const backRef = createRef<(() => boolean) | null>();
    const ui = () => (
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
    const view = await renderWithProviders(ui());
    await act(async () => void backRef.current?.());
    expect(
      screen.getByTestId('player-overlay-hidden', { includeHiddenElements: true })
    ).toBeTruthy();
    (controller as { paused: boolean }).paused = true;
    await view.rerender(ui());
    expect(screen.getByTestId('player-overlay')).toBeTruthy();
  });
});

describe('TV: ▼ from the scrubber reaches the button row (S6x Left, Google TV)', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('▼ hands the D-pad to the buttons at once: a quick ▶ right after it never scrubs', async () => {
    jest.useFakeTimers();
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    const backRef = createRef<(() => boolean) | null>();
    const controller = await overlay(backRef);
    // Hidden: ▼ shows the controls on the scrubber.
    await act(async () => void backRef.current?.());
    await act(async () => mockKeys.listener?.({ key: 'down', repeat: 0 }));
    expect(screen.getByTestId('player-position')).toHaveTextContent('0:52');
    // ▼ to the buttons and ▶ before the next render, as a remote (or adb) sends them.
    await act(async () => {
      mockKeys.listener?.({ key: 'down', repeat: 0 });
      mockKeys.listener?.({ key: 'right', repeat: 0 });
    });
    await act(async () => jest.runOnlyPendingTimers());
    expect(controller.seekTo).not.toHaveBeenCalled();
    expect(screen.getByTestId('player-position')).toHaveTextContent('0:52');
  });
});

describe('subtitle cues above the control bar while it shows (Q2-02)', () => {
  afterEach(() => {
    mockWindow = undefined;
  });

  it('web 1280×800: the bar from y 645 lifts the cues above its top; hidden, they go back', async () => {
    jest.useFakeTimers();
    mockWindow = { width: 1280, height: 800, scale: 2, fontScale: 1 };
    const controller = fakeController();
    const setSubtitleLift = jest.fn();
    Object.assign(controller.engine!, { setSubtitleLift });
    await renderWithProviders(
      <PlayerOverlay
        controller={controller}
        clock={{ position: 46, duration: 600, buffered: 60 }}
        title="Sherlock"
        suspended={false}
        onPanel={jest.fn()}
        onClose={jest.fn()}
        backRef={createRef()}
      />
    );
    await act(async () =>
      fireEvent(screen.getByTestId('player-bar'), 'layout', {
        nativeEvent: { layout: { x: 0, y: 645, width: 1200, height: 128 } },
      })
    );
    expect(setSubtitleLift).toHaveBeenLastCalledWith(1 - 645 / 800);
    await act(async () => jest.advanceTimersByTime(6_000));
    expect(setSubtitleLift).toHaveBeenLastCalledWith(0);
    jest.useRealTimers();
  });
});
