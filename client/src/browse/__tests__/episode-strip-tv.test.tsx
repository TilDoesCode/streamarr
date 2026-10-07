import { screen } from '@testing-library/react-native';
import { Platform, StyleSheet } from 'react-native';

import type { Episode } from '@/browse/queries';
import i18n from '@/i18n';
import { DesignGutter } from '@/theme';
import { renderWithProviders } from '@/../jest/render';

import { EpisodeStrip } from '../episode-strip';

// RN's Jest mock of the native View lacks Commands; TVFocusGuideView sends setDestinations on TV.
jest.mock('react-native/Libraries/Components/View/ViewNativeComponent', () => ({
  ...jest.requireActual('@react-native/jest-preset/jest/mocks/ViewNativeComponent'),
  Commands: { setDestinations: jest.fn(), requestTVFocus: jest.fn() },
}));

let mockWindow = { width: 960, height: 540, scale: 2, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => mockWindow,
}));

beforeAll(async () => {
  await i18n.changeLanguage('de');
});
afterEach(() => {
  jest.restoreAllMocks();
});

const episodes = Array.from(
  { length: 26 },
  (_, at) =>
    ({
      workId: `tmdb-tv-990001-s01e${String(at + 1).padStart(2, '0')}`,
      episodeNumber: at + 1,
      title: `E${at + 1}`,
      aired: true,
      watch: { played: at < 15 },
    }) as unknown as Episode
);

const strip = (gutterStart: number) => (
  <EpisodeStrip
    episodes={episodes}
    selected={16}
    scrollKey="1"
    gutterStart={gutterStart}
    gutterEnd={32}
    onPreview={jest.fn()}
    onSelect={jest.fn()}
    onPlay={jest.fn()}
    onVersions={jest.fn()}
  />
);

/** The strip's list: where it starts on screen, its first-card padding and its TV snap padding. */
async function list(ui: React.ReactElement) {
  await renderWithProviders(ui);
  const host = screen.getByTestId('episode-strip-list');
  return {
    left: (StyleSheet.flatten(host.props.style).marginLeft ?? 0) as number,
    paddingLeft: StyleSheet.flatten(host.props.contentContainerStyle).paddingLeft as number,
    snap: host.props.snapToItemPadding as number | undefined,
  };
}

describe('episode strip on Google TV (Q2-04)', () => {
  it('starts at the rail edge so cards never scroll under the translucent rail', async () => {
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    // LargeShell at 960 × 540 dp (scale 0.5): rail 104 → 52, gutter 64 → 32, content start 84.
    const strip84 = await list(
      <DesignGutter gutter={32} inset={52}>
        {strip(84)}
      </DesignGutter>
    );
    expect(strip84.left).toBe(52);
    // First card and the focused card's snap position stay where they were on screen.
    expect(strip84.left + strip84.paddingLeft).toBe(84);
    // Card 176 + gap 20: the focused card one stride in from the gutter (stripOffset geometry).
    expect(strip84.left + strip84.snap!).toBe(84 + 196);
  });

  it('changes nothing on a phone (no rail, full bleed)', async () => {
    mockWindow = { width: 390, height: 844, scale: 3, fontScale: 1 };
    const phone = await list(strip(20));
    expect(phone.left).toBe(0);
    expect(phone.paddingLeft).toBe(20);
    expect(phone.snap).toBeUndefined();
  });
});
