import { fireEvent, screen } from '@testing-library/react-native';
import { ScrollView } from 'react-native';

import '@/i18n';
import { renderWithProviders } from '@/../jest/render';
import { cutSeasons, SeasonChips } from '@/browse/season-chips';

const seasons = [1, 2, 3, 4, 5, 6].map((seasonNumber) => ({
  seasonNumber,
  episodeCount: 6,
  playedCount: 0,
}));
const CHIP = 200;

const layout = (testID: string, box: { x: number; width: number }) =>
  fireEvent(screen.getByTestId(testID), 'layout', {
    nativeEvent: { layout: { ...box, y: 0, height: 48 } },
  });

async function open(season: number, viewport: number) {
  const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => undefined);
  // RN's ScrollView mock already is a jest.fn: spyOn hands back the same one in every test.
  scrollTo.mockClear();
  await renderWithProviders(
    <SeasonChips
      seasons={seasons as never}
      season={season}
      position="Episode 3 of 6"
      onSeason={() => undefined}
    />
  );
  for (const item of seasons)
    await layout(`season-${item.seasonNumber}`, { x: (item.seasonNumber - 1) * CHIP, width: CHIP });
  await layout('series-seasons-scroll', { x: 0, width: viewport });
  return scrollTo;
}

afterEach(() => jest.restoreAllMocks());

describe('season chips of a long series (photos 03/04)', () => {
  it('starts scrolled to the active season instead of Season 1', async () => {
    const scrollTo = await open(6, 700);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    const { x, animated } = scrollTo.mock.calls[0]![0] as { x: number; animated: boolean };
    // Season 6 ends at 1200 px: it and its focus glow sit inside the 700 px viewport, without an animation.
    expect(x).toBeGreaterThan(1200 - 700);
    expect(x).toBeLessThanOrEqual(5 * CHIP);
    expect(animated).toBe(false);
  });

  it('leaves the row alone when the active season is already in view', async () => {
    const scrollTo = await open(2, 700);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('follows the active season while the sizes settle (web fonts, late data)', async () => {
    const scrollTo = await open(6, 700);
    // Wider labels after the font loads: Season 6 moves right, so the row scrolls again.
    await layout('season-6', { x: 5 * 260, width: 260 });
    expect(scrollTo).toHaveBeenCalledTimes(2);
    expect((scrollTo.mock.calls[1]![0] as { x: number }).x).toBeGreaterThan(5 * 260 + 260 - 700);
  });

  it('stops following once the viewer moved through the row themselves', async () => {
    const scrollTo = await open(6, 700);
    await fireEvent(screen.getByTestId('season-2'), 'focus');
    scrollTo.mockClear();
    await layout('season-6', { x: 5 * 260, width: 260 });
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('keeps the episode position beside the chips, never squeezed by them', async () => {
    await open(6, 700);
    expect(screen.getByTestId('series-episode-position')).toHaveStyle({ flexShrink: 0 });
  });
});

describe('cutSeasons (Android: a cut chip dims, no MaskedView fade)', () => {
  const boxes = new Map(
    seasons.map((item) => [item.seasonNumber, { x: (item.seasonNumber - 1) * CHIP, width: CHIP }])
  );

  it('dims the chips the row edges cut, not the ones fully in view', () => {
    // Viewport 300..1000: Season 2 starts at 200 (cut left), Season 5 ends at 1000 (in), Season 6 is past the edge.
    expect(cutSeasons(boxes, 300, 700)).toEqual([1, 2, 6]);
  });

  it('never dims the focused chip and nothing before the row is measured', () => {
    expect(cutSeasons(boxes, 300, 700, 6)).toEqual([1, 2]);
    expect(cutSeasons(boxes, 0, 0)).toEqual([]);
  });
});
