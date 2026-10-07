import { act, screen } from '@testing-library/react-native';
import { FlatList, StyleSheet } from 'react-native';

import type { Episode } from '@/browse/queries';
import i18n from '@/i18n';
import { renderWithProviders } from '@/../jest/render';

import { cornerNumberBottom, EpisodeStrip, numberInCorner, stripClip } from '../episode-strip';

let mockWindow = { width: 1024, height: 1366, scale: 2, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => mockWindow,
}));

beforeAll(async () => {
  await i18n.changeLanguage('de');
});

const episodes = Array.from(
  { length: 26 },
  (_, at) =>
    ({
      workId: `tmdb-tv-990001-s01e${String(at + 1).padStart(2, '0')}`,
      episodeNumber: at + 1,
      title: `E${at + 1}`,
      aired: true,
      watch: { played: false },
    }) as unknown as Episode
);

const strip = () => (
  <EpisodeStrip
    episodes={episodes}
    selected={21}
    scrollKey="1"
    gutterStart={101}
    gutterEnd={58}
    onPreview={jest.fn()}
    onSelect={jest.fn()}
    onPlay={jest.fn()}
    onVersions={jest.fn()}
  />
);

describe('episode strip on iPad (Q1-49/50/51)', () => {
  it('starts at the rail edge wherever a rail floats (iPad, web, Google TV), full bleed without one', () => {
    expect(stripClip(62, 101)).toEqual({ left: 62, paddingLeft: 39 });
    expect(stripClip(52, 84)).toEqual({ left: 52, paddingLeft: 32 });
    // Phones and Apple TV (top tab bar) have no rail.
    expect(stripClip(0, 20)).toEqual({ left: 0, paddingLeft: 20 });
  });

  it('moves the number of a card without a still out of the middle and the badge corner', () => {
    expect(numberInCorner({ badges: 0, touch: true })).toBe(true);
    expect(numberInCorner({ badges: 1, touch: false })).toBe(true);
    expect(numberInCorner({ badges: 0, touch: false })).toBe(false);
  });

  it('lifts a corner number above the progress bar (V1: "26" drawn over the bar)', () => {
    expect(cornerNumberBottom(14, false, 13)).toBe(14);
    expect(cornerNumberBottom(14, true, 13)).toBe(27);
  });

  it('scrolls the marked card back into view after a rotation', async () => {
    const scroll = jest.spyOn(FlatList.prototype, 'scrollToOffset');
    const view = await renderWithProviders(strip());
    const first = scroll.mock.calls.at(-1)?.[0].offset ?? 0;
    expect(first).toBeGreaterThan(0);
    scroll.mockClear();
    mockWindow = { width: 1366, height: 1024, scale: 2, fontScale: 1 };
    await act(async () => view.rerender(strip()));
    expect(scroll).toHaveBeenCalled();
    const after = scroll.mock.calls.at(-1)![0].offset!;
    // Card 21 at the start again with the landscape card size.
    expect(after).toBeGreaterThan(first);
    scroll.mockRestore();
  });

  it('draws the number of a started card without a still above its progress bar', async () => {
    mockWindow = { width: 1280, height: 657, scale: 1, fontScale: 1 };
    const started = {
      workId: 'tmdb-tv-990001-s01e26',
      episodeNumber: 26,
      title: 'E26',
      aired: true,
      watch: { played: false, positionTicks: 320_000_000, durationTicks: 600_000_000 },
    } as unknown as Episode;
    await renderWithProviders(
      <EpisodeStrip
        episodes={[started]}
        selected={26}
        scrollKey="1"
        gutterStart={101}
        gutterEnd={58}
        onPreview={jest.fn()}
        onSelect={jest.fn()}
        onPlay={jest.fn()}
        onVersions={jest.fn()}
      />
    );
    const number = StyleSheet.flatten(screen.getByTestId('episode-card-26-number').props.style);
    expect(number.paddingBottom).toBeGreaterThan(number.padding as number);
  });
});
