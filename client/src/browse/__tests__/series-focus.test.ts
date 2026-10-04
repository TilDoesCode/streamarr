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
const other: WatchState = {
  ...s2e2,
  workId: 'tmdb-tv-1-s01e01',
  seriesWorkId: 'tmdb-tv-1',
  lastReleaseId: 'x',
};

describe('series focus follows the server (B9 CurrentEpisodeRule)', () => {
  it('takes the server episode and adds the version last played on it', () => {
    const replay = { ...s2e2, reason: 'resume', available: true };
    const focus = seriesFocus(series(replay), [other, s2e2]);
    expect(focus).toMatchObject({
      workId: s2e2.workId,
      seasonNumber: 2,
      episodeNumber: 2,
      positionTicks: s2e2.positionTicks,
      available: true,
      lastReleaseId: 'webdl',
    });
    expect(initialSelection(series(replay), {}, focus)).toEqual({ season: 2, episode: 2 });
  });

  it('never lets a continue entry override the server episode (stale resume, review risk 1)', () => {
    // An abandoned S2E2 resume point while the server says S3E1: the server wins.
    const focus = seriesFocus(series(), [s2e2]);
    expect(focus).toMatchObject({ workId: s3e1.workId, lastReleaseId: undefined });
    expect(seriesFocus(series(), undefined)?.workId).toBe(s3e1.workId);
    expect(seriesFocus(series(null), [s2e2])).toBeNull();
  });

  it('still honours a deep link first', () => {
    expect(
      initialSelection(series(), { season: 1, episode: 3 }, seriesFocus(series(), [s2e2]))
    ).toEqual({ season: 1, episode: 3 });
  });
});

describe('episode card (Q1-03, Q1-26)', () => {
  it('draws one badge only: "No version" wins over "Up next" (two wrap on a web card)', () => {
    expect(cardBadges({ next: true, noVersion: true })).toEqual(['detail.noVersionShort']);
    expect(cardBadges({ next: true, noVersion: false })).toEqual(['media.upNext']);
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

  it('does not fetch versions just to start the server pick (no per-card probe)', async () => {
    const fetchVersions = jest.fn(async () => versions);
    await expect(
      resolvePlay(fetchVersions, {
        workId: 's3e1',
        title: 't',
        watch: { positionTicks: 0, durationTicks: null },
      })
    ).resolves.toEqual({ workId: 's3e1', title: 't', startSeconds: 0 });
    expect(fetchVersions).not.toHaveBeenCalled();
  });
});
