import type { SeriesDetail, Version, WatchState } from '@/browse/queries';
import { initialSelection, seriesFocus } from '@/browse/series-selection';
import { cardBadges, showsSelectionRing } from '@/browse/episode-strip';
import { resolvePlay } from '@/browse/title-actions';

const SERIES = 'tmdb-tv-19885';
const s3e1 = { workId: `${SERIES}-s03e01`, seasonNumber: 3, episodeNumber: 1, reason: 'next' };
const series = (next: object | null = s3e1) =>
  ({
    workId: SERIES,
    seasons: [1, 2, 3].map((seasonNumber) => ({ seasonNumber })),
    watch: { nextEpisode: next },
  }) as unknown as SeriesDetail;
// Q1-04: S2E2 was watched, then replayed (B8 keeps the new resume point), so it is played AND in progress.
const s2e2: WatchState = {
  workId: `${SERIES}-s02e02`,
  kind: 'episode',
  seriesWorkId: SERIES,
  seasonNumber: 2,
  episodeNumber: 2,
  title: 'The Hounds of Baskerville',
  positionTicks: 3_000_000_000,
  durationTicks: 3_300_000_000,
  played: true,
  lastReleaseId: 'webdl',
};
const other: WatchState = { ...s2e2, workId: 'tmdb-tv-1-s01e01', seriesWorkId: 'tmdb-tv-1' };

describe('series focus (Q1-04/26/36/27)', () => {
  it('prefers the episode with an active resume point over the next episode', () => {
    const focus = seriesFocus(series(), [other, s2e2]);
    expect(focus).toMatchObject({
      workId: s2e2.workId,
      seasonNumber: 2,
      episodeNumber: 2,
      reason: 'resume',
      positionTicks: s2e2.positionTicks,
      lastReleaseId: 'webdl',
    });
    expect(initialSelection(series(), {}, focus)).toEqual({ season: 2, episode: 2 });
  });

  it('falls back to the next episode without a resume point of this series', () => {
    expect(seriesFocus(series(), [other])?.workId).toBe(s3e1.workId);
    expect(seriesFocus(series(), undefined)?.workId).toBe(s3e1.workId);
    expect(seriesFocus(series(null), [])).toBeNull();
    expect(seriesFocus(series(), [{ ...s2e2, positionTicks: 0 }])?.workId).toBe(s3e1.workId);
  });

  it('keeps the server episode and adds the last played version when both agree', () => {
    const resume = { ...s3e1, positionTicks: 10, reason: 'resume' };
    const focus = seriesFocus(series(resume), [{ ...s2e2, workId: s3e1.workId }]);
    expect(focus).toMatchObject({ workId: s3e1.workId, lastReleaseId: 'webdl' });
  });

  it('still honours a deep link first', () => {
    expect(
      initialSelection(series(), { season: 1, episode: 3 }, seriesFocus(series(), [s2e2]))
    ).toEqual({
      season: 1,
      episode: 3,
    });
  });
});

describe('episode card (Q1-03, Q1-26)', () => {
  it('puts "Up next" and "No version" side by side in one badge row', () => {
    expect(cardBadges({ next: true, noVersion: true })).toEqual([
      'media.upNext',
      'detail.noVersionShort',
    ]);
    expect(cardBadges({ next: false, noVersion: false })).toEqual([]);
  });

  it('draws the selection ring only off TV, where focus has its own ring', () => {
    expect(showsSelectionRing(true, false)).toBe(true);
    expect(showsSelectionRing(true, true)).toBe(false);
    expect(showsSelectionRing(false, false)).toBe(false);
  });
});

describe('Home cards play by the playTarget rule (Q1-05)', () => {
  const v = (releaseId: string, extra: Partial<Version>) =>
    ({ releaseId, rank: 1, recommended: false, ...extra }) as Version;
  const versions = [
    v('bluray', { recommended: true, predictedMethod: 'direct', resolution: '1080p' }),
    v('webdl', { rank: 2, predictedMethod: 'direct', resolution: '720p' }),
  ];
  const watch = {
    positionTicks: 880_000_000,
    durationTicks: 1_800_000_000,
    lastReleaseId: 'webdl',
  };

  it('resumes the last played version like the detail', async () => {
    const fetchVersions = jest.fn(async () => versions);
    await expect(
      resolvePlay(fetchVersions, { workId: 'tmdb-movie-1', title: 'ToS', watch })
    ).resolves.toEqual({
      workId: 'tmdb-movie-1',
      title: 'ToS',
      startSeconds: 88,
      releaseId: 'webdl',
    });
  });

  it('lets the server recommend when nothing was played or the versions fail', async () => {
    const fetchVersions = jest.fn(async () => versions);
    await expect(
      resolvePlay(fetchVersions, { workId: 'w', title: 't', watch: { ...watch, positionTicks: 0 } })
    ).resolves.toEqual({ workId: 'w', title: 't', startSeconds: 0 });
    expect(fetchVersions).not.toHaveBeenCalled();
    const failing = jest.fn(async (): Promise<Version[]> => {
      throw new Error('offline');
    });
    await expect(resolvePlay(failing, { workId: 'w', title: 't', watch })).resolves.toEqual({
      workId: 'w',
      title: 't',
      startSeconds: 88,
    });
  });

  it('checks a next-up episode first and reports one without versions (Q1-08)', async () => {
    const none = jest.fn(async (): Promise<Version[]> => []);
    const next = { positionTicks: 0, durationTicks: null };
    await expect(
      resolvePlay(none, { workId: 's3e1', title: 't', watch: next }, true)
    ).resolves.toBeNull();
    await expect(
      resolvePlay(
        jest.fn(async () => versions),
        { workId: 's2e3', title: 't', watch: next },
        true
      )
    ).resolves.toEqual({ workId: 's2e3', title: 't', startSeconds: 0 });
  });
});
