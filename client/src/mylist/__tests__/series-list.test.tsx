import { act, fireEvent, screen } from '@testing-library/react-native';

import i18n from '@/i18n';
import { renderWithProviders } from '@/../jest/render';

import { listSeason, SeriesListButton, useSeriesList } from '../series-list';

type Entry = { onList: boolean; ready: boolean; pending: boolean; toggle: jest.Mock };
const entries: Record<string, Entry> = {};
const entry = (workId: string, over: Partial<Entry> = {}): Entry =>
  (entries[workId] = { onList: false, ready: true, pending: false, toggle: jest.fn(), ...over });

jest.mock('../queries', () => ({
  useListToggle: ({ workId }: { workId: string | null | undefined }) =>
    (workId ? entries[workId] : undefined) ?? {
      onList: false,
      ready: false,
      pending: false,
      toggle: () => undefined,
    },
}));

const seasons = [
  { seasonNumber: 0, workId: 'tmdb-tv-1-s00', title: 'Specials' },
  { seasonNumber: 1, workId: 'tmdb-tv-1-s01', title: 'Season 1' },
  { seasonNumber: 2, workId: 'tmdb-tv-1-s02', title: 'Season 2' },
];

beforeAll(() => i18n.changeLanguage('en'));
beforeEach(() => {
  for (const key of Object.keys(entries)) delete entries[key];
});

describe('listSeason', () => {
  it('offers the selected regular season of a series with several', () => {
    expect(listSeason(seasons, 2)).toMatchObject({ seasonNumber: 2, workId: 'tmdb-tv-1-s02' });
  });

  it('offers none for specials, an unknown season or a single regular season', () => {
    expect(listSeason(seasons, 0)).toBeUndefined();
    expect(listSeason(seasons, 9)).toBeUndefined();
    expect(listSeason(seasons, undefined)).toBeUndefined();
    expect(listSeason(seasons.slice(0, 2), 1)).toBeUndefined();
    expect(listSeason(undefined, 1)).toBeUndefined();
  });

  it('offers none for a season the server has no work id for', () => {
    expect(
      listSeason([seasons[1]!, { seasonNumber: 2, workId: null, title: null }], 2)
    ).toBeUndefined();
  });
});

function Harness({ season }: { season?: boolean }) {
  const list = useSeriesList({
    workId: 'tmdb-tv-1',
    title: 'Show',
    season: season ? { workId: 'tmdb-tv-1-s02', number: 2 } : undefined,
  });
  return (
    <>
      <SeriesListButton testID="series-list" list={list} />
      {list.dialog}
    </>
  );
}

describe('series list button', () => {
  it('toggles the series directly without a season context', async () => {
    const series = entry('tmdb-tv-1');
    await renderWithProviders(<Harness />);
    expect(screen.getByRole('button', { name: 'Add to My List' })).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('series-list'));
    expect(series.toggle).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('series-list-choice')).toBeNull();
  });

  it('opens the chooser with a season context and toggles the series', async () => {
    const series = entry('tmdb-tv-1');
    const season = entry('tmdb-tv-1-s02');
    await renderWithProviders(<Harness season />);
    await fireEvent.press(screen.getByTestId('series-list'));
    expect(series.toggle).not.toHaveBeenCalled();
    expect(await screen.findByTestId('series-list-choice')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('series-list-choice-series'));
    expect(series.toggle).toHaveBeenCalledTimes(1);
    expect(season.toggle).not.toHaveBeenCalled();
    expect(screen.queryByTestId('series-list-choice')).toBeNull();
  });

  it('toggles only the season from the chooser', async () => {
    const series = entry('tmdb-tv-1');
    const season = entry('tmdb-tv-1-s02');
    await renderWithProviders(<Harness season />);
    await fireEvent.press(screen.getByTestId('series-list'));
    await fireEvent.press(await screen.findByTestId('series-list-choice-season'));
    expect(season.toggle).toHaveBeenCalledTimes(1);
    expect(series.toggle).not.toHaveBeenCalled();
  });

  it('shows each option’s own state and is on the list when either is', async () => {
    entry('tmdb-tv-1');
    entry('tmdb-tv-1-s02', { onList: true });
    await renderWithProviders(<Harness season />);
    expect(screen.getByTestId('series-list')).toBeSelected();
    await fireEvent.press(screen.getByTestId('series-list'));
    expect(await screen.findByTestId('series-list-choice-season')).toBeSelected();
    expect(screen.getByTestId('series-list-choice-series')).not.toBeSelected();
  });

  it('is off the list when neither is, and cancel closes the chooser untouched', async () => {
    const series = entry('tmdb-tv-1');
    const season = entry('tmdb-tv-1-s02');
    await renderWithProviders(<Harness season />);
    expect(screen.getByTestId('series-list')).not.toBeSelected();
    await fireEvent.press(screen.getByTestId('series-list'));
    await fireEvent.press(await screen.findByText('Cancel'));
    await act(async () => undefined);
    expect(screen.queryByTestId('series-list-choice')).toBeNull();
    expect(series.toggle).not.toHaveBeenCalled();
    expect(season.toggle).not.toHaveBeenCalled();
  });

  it('is disabled until both entries are known, or while one is saving', async () => {
    entry('tmdb-tv-1');
    entry('tmdb-tv-1-s02', { ready: false });
    const view = await renderWithProviders(<Harness season />);
    expect(screen.getByTestId('series-list')).toBeDisabled();
    entry('tmdb-tv-1-s02', { pending: true });
    await view.rerender(<Harness season />);
    expect(screen.getByTestId('series-list')).toBeDisabled();
  });
});
