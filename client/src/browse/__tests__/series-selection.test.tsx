import type { Episode, SeriesDetail } from '@/browse/queries';
import {
  createDebouncer,
  initialSelection,
  orderedSeasons,
  PREVIEW_DELAY_MS,
  seasonEntry,
  selectedEpisode,
} from '@/browse/series-selection';

const season = (seasonNumber: number) => ({ seasonNumber, workId: null, title: null });
const series = (next: SeriesDetail['watch']['nextEpisode'] = null) =>
  ({
    seasons: [season(0), season(1), season(2)],
    watch: { nextEpisode: next },
  }) as unknown as Pick<SeriesDetail, 'seasons' | 'watch'>;
const episode = (episodeNumber: number, played = false, aired = true) =>
  ({
    workId: `w${episodeNumber}`,
    episodeNumber,
    title: `E${episodeNumber}`,
    aired,
    watch: { played },
  }) as unknown as Episode;

describe('series selection', () => {
  it('orders specials last', () => {
    expect(orderedSeasons([season(0), season(2), season(1)]).map((s) => s.seasonNumber)).toEqual([
      1, 2, 0,
    ]);
  });

  it('starts at the deep link, else the next episode, else the first regular season', () => {
    expect(initialSelection(series(), { season: 2, episode: 3 })).toEqual({
      season: 2,
      episode: 3,
    });
    // An unknown season in the link falls back.
    expect(initialSelection(series(), { season: 9 })).toEqual({ season: 1, episode: null });
    const next = { seasonNumber: 2, episodeNumber: 1, workId: 'x', reason: 'next' };
    expect(initialSelection(series(next), {})).toEqual({ season: 2, episode: 1 });
    // Specials are never preselected.
    expect(initialSelection(series(), {})).toEqual({ season: 1, episode: null });
  });

  it('enters a season on the next, else the first unwatched aired, else the first episode', () => {
    const list = [episode(1, true), episode(2), episode(3)];
    expect(seasonEntry(list)?.episodeNumber).toBe(2);
    expect(seasonEntry(list, 'w3')?.episodeNumber).toBe(3);
    expect(seasonEntry([episode(1, true), episode(2, false, false)])?.episodeNumber).toBe(1);
    expect(selectedEpisode(list, { season: 1, episode: 3 })?.episodeNumber).toBe(3);
    expect(selectedEpisode(list, { season: 1, episode: 9 })?.episodeNumber).toBe(2);
  });

  it('previews only after the focus rested for 150 ms', () => {
    jest.useFakeTimers();
    const apply = jest.fn();
    const debouncer = createDebouncer();
    debouncer.schedule(() => apply(1));
    jest.advanceTimersByTime(100);
    debouncer.schedule(() => apply(2));
    jest.advanceTimersByTime(PREVIEW_DELAY_MS - 1);
    expect(apply).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(2);
    debouncer.schedule(() => apply(3));
    debouncer.cancel();
    jest.advanceTimersByTime(PREVIEW_DELAY_MS);
    expect(apply).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });
});
