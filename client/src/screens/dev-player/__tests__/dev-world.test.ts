import { variantCases } from '../dev-world';

describe('variantCases', () => {
  it('picks one ready release per variant and adds the fallback and degraded scenarios', () => {
    const cases = variantCases({
      titles: [
        {
          title: 'Cosmos',
          workId: 'tmdb-movie-1',
          releases: [
            { releaseId: 'dead', variant: 'mkv-hevc', health: 'dead', rank: 1 },
            {
              releaseId: 'good',
              variant: 'mkv-hevc',
              variantLabel: 'MKV HEVC',
              health: 'ready',
              rank: 2,
            },
          ],
        },
        {
          title: 'Tears',
          workId: 'tmdb-movie-2',
          releases: [
            { releaseId: 'bad', variant: 'mkv-h264', health: 'degraded', rank: 1 },
            { releaseId: 'mp4', variant: 'mp4-h264', health: 'ready', rank: 2 },
            { releaseId: 'again', variant: 'mkv-hevc', health: 'ready', rank: 3 },
          ],
        },
      ],
      scenarios: { deadFallback: [{ workId: 'tmdb-movie-1' }] },
    });
    expect(cases.map((item) => [item.id, item.releaseId])).toEqual([
      ['mkv-hevc', 'good'],
      ['mp4-h264', 'mp4'],
      ['fallback', undefined],
      ['degraded', undefined],
    ]);
    expect(cases[0]).toMatchObject({ label: 'MKV HEVC', title: 'Cosmos', workId: 'tmdb-movie-1' });
    expect(cases[3]).toMatchObject({ scenario: 'degraded', workId: 'tmdb-movie-2' });
  });
});
