import { screen } from '@testing-library/react-native';
import { Platform, StyleSheet, View } from 'react-native';

import '@/i18n';
import { renderWithProviders } from '@/../jest/render';
import { SeasonChips } from '@/browse/season-chips';
import { StageActionRow } from '@/screens/detail/stage-action-row';
import { GenreRow } from '@/screens/library/genre-row';
import { LanguageSection } from '@/screens/settings/settings-screen';
import { createDesign } from '@/theme/design';

// RN's Jest mock of the native View lacks Commands; TVFocusGuideView sends setDestinations on TV.
jest.mock('react-native/Libraries/Components/View/ViewNativeComponent', () => ({
  ...jest.requireActual('@react-native/jest-preset/jest/mocks/ViewNativeComponent'),
  Commands: { setDestinations: jest.fn(), requestTVFocus: jest.fn() },
}));
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ width: 1920, height: 1080, scale: 1, fontScale: 1 }),
}));

beforeEach(() => {
  jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
});
afterEach(() => {
  jest.restoreAllMocks();
});

// The focus clearance on the 1920 TV canvas is wider than every row's own design gap.
const { focus } = createDesign('tv', 1920, 1080);
const gapOf = (testID: string, style: 'style' | 'contentContainerStyle' = 'style') =>
  StyleSheet.flatten(screen.getByTestId(testID).props[style]).gap as number;

describe('TV focus gaps per row primitive', () => {
  it('keeps the clearance on 1920 above a fixed design gap (self-check)', () => {
    expect(focus.rowGap).toBeGreaterThan(28);
  });

  it('action row (Bühne Play/Resume/Start over)', async () => {
    await renderWithProviders(
      <StageActionRow>
        <View testID="a" />
        <View testID="b" />
      </StageActionRow>
    );
    expect(gapOf('stage-actions')).toBeGreaterThanOrEqual(focus.rowGap);
  });

  it('chip row (seasons)', async () => {
    const seasons = [1, 2].map((seasonNumber) => ({
      seasonNumber,
      episodeCount: 3,
      playedCount: 0,
    }));
    await renderWithProviders(
      <SeasonChips seasons={seasons as never} season={1} onSeason={() => undefined} />
    );
    expect(gapOf('series-seasons')).toBeGreaterThanOrEqual(focus.rowGap);
  });

  it('chip row (library genres)', async () => {
    await renderWithProviders(
      <GenreRow
        chips={[1, 2, 3].map((id) => ({ id, name: `G${id}` }))}
        selected={null}
        selectedRef={{ current: null }}
        selectedNode={null}
        label="Genres"
        onSelect={() => undefined}
        onChipFocus={() => undefined}
      />
    );
    expect(gapOf('library-genres-scroll', 'contentContainerStyle')).toBeGreaterThanOrEqual(
      focus.rowGap
    );
  });

  it('genre scroller before the Apple TV sort control (end padding)', async () => {
    await renderWithProviders(
      <GenreRow
        chips={[1, 2, 3].map((id) => ({ id, name: `G${id}` }))}
        selected={null}
        selectedRef={{ current: null }}
        selectedNode={null}
        label="Genres"
        onSelect={() => undefined}
        onChipFocus={() => undefined}
        trailing={<View testID="sort" />}
      />
    );
    const content = StyleSheet.flatten(
      screen.getByTestId('library-genres-scroll').props.contentContainerStyle
    );
    expect(content.paddingRight).toBeGreaterThanOrEqual(focus.rowGap);
  });

  it('chip row (settings language, Q1-28)', async () => {
    await renderWithProviders(<LanguageSection />);
    expect(gapOf('settings-language-chips')).toBeGreaterThanOrEqual(focus.rowGap);
  });
});
