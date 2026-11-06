import type { DownloadCandidate, DownloadPack, DownloadPlanItem, SpaceVerdict } from '@/downloads';
import { libraryLink } from '@/navigation/library-link';
import { nativeTabs, railTabs } from '@/navigation/tabs';

import {
  candidateNotes,
  defaultCandidate,
  eachRows,
  packRows,
  requestItems,
  seasonWorkIdOf,
  selectionOf,
  similarRows,
  type RowInput,
} from '../download-model';

const GB = 1_000_000_000;

function candidate(
  releaseId: string,
  patch: Partial<DownloadCandidate> & { fits?: boolean } = {}
): DownloadCandidate & { space: SpaceVerdict } {
  const { fits = true, ...rest } = patch;
  return {
    version: { releaseId, name: `Show.S01.${releaseId}`, rank: 1 } as DownloadCandidate['version'],
    offline: { playable: true, engine: 'native', reasons: [] },
    sizeBytes: GB,
    sizeExact: true,
    sizeSource: 'resolved',
    seasonPack: false,
    recommended: false,
    ...rest,
    space: { fits, neededBytes: GB, availableBytes: 0, missingBytes: 0, estimate: false },
  };
}

const episode = (n: number, candidates: DownloadCandidate[], aired = true) => ({
  workId: `tmdb-tv-1-s01e0${n}`,
  episodeNumber: n,
  title: `Episode ${n}`,
  aired,
  candidates,
  streamOnlyCount: 0,
});

const input = (patch: Partial<RowInput> = {}): RowInput => ({
  episodes: [
    episode(1, [candidate('a1', { recommended: true }), candidate('b1')]),
    episode(2, [candidate('a2', { recommended: true }), candidate('b2')]),
    episode(3, [candidate('x3', { offline: { playable: false, reasons: [] } })]),
    episode(4, [], false),
  ],
  existing: [],
  overrides: {},
  deselected: new Set(),
  ...patch,
});

describe('defaultCandidate', () => {
  it('takes the recommended version when it fits, else the first one that fits', () => {
    expect(defaultCandidate([candidate('a'), candidate('b', { recommended: true })])).toMatchObject(
      { version: { releaseId: 'b' } }
    );
    expect(
      defaultCandidate([
        candidate('a', { recommended: true, fits: false }),
        candidate('b', { fits: false }),
        candidate('c'),
      ])
    ).toMatchObject({ version: { releaseId: 'c' } });
    expect(defaultCandidate([candidate('a', { fits: false })])).toBeUndefined();
  });

  it('never picks a version that needs converting', () => {
    expect(
      defaultCandidate([
        candidate('a', { recommended: true, offline: { playable: false, reasons: [] } }),
      ])
    ).toBeUndefined();
  });
});

describe('seasonWorkIdOf', () => {
  it('maps an episode to its season and keeps a season', () => {
    expect(seasonWorkIdOf('tmdb-tv-1396-s02e03')).toBe('tmdb-tv-1396-s02');
    expect(seasonWorkIdOf('tmdb-tv-1396-s02')).toBe('tmdb-tv-1396-s02');
    expect(seasonWorkIdOf('tmdb-movie-603')).toBeNull();
  });
});

describe('review rows', () => {
  it('"each yourself" prefills the recommended version, keeps picks and deselections', () => {
    const rows = eachRows(
      input({ overrides: { 'tmdb-tv-1-s01e02': 'b2' }, deselected: new Set(['tmdb-tv-1-s01e01']) })
    );
    expect(
      rows.map((row) => [row.status, row.candidate?.version.releaseId, row.match, row.selected])
    ).toEqual([
      ['ready', 'a1', 'recommended', false],
      ['ready', 'b2', 'manual', true],
      ['unavailable', undefined, null, false],
      ['unavailable', undefined, null, false],
    ]);
    expect(rows[2]!.choices).toHaveLength(0);
  });

  it('shows downloaded and running episodes but never selects them', () => {
    const rows = eachRows(
      input({
        existing: [
          { workId: 'tmdb-tv-1-s01e01', state: 'done' },
          { workId: 'tmdb-tv-1-s01e02', state: 'downloading' },
        ],
      })
    );
    expect(rows.slice(0, 2).map((row) => [row.status, row.selected])).toEqual([
      ['on_device', false],
      ['in_progress', false],
    ]);
  });

  it('"rest similar" takes the plan per episode and the anchor\'s own pick', () => {
    const plan: DownloadPlanItem[] = [
      { workId: 'tmdb-tv-1-s01e02', match: 'same_group', score: 80, candidate: candidate('b2') },
      { workId: 'tmdb-tv-1-s01e03', match: 'none', candidate: null },
    ];
    const rows = similarRows(input(), plan, { workId: 'tmdb-tv-1-s01e01', releaseId: 'b1' });
    expect(rows.map((row) => [row.status, row.candidate?.version.releaseId, row.match])).toEqual([
      ['ready', 'b1', 'same_release'],
      ['ready', 'b2', 'same_group'],
      ['unavailable', undefined, null],
      ['unavailable', undefined, null],
    ]);
  });

  it('"rest similar" rows wait for the plan', () => {
    const rows = similarRows(input(), undefined, { workId: 'tmdb-tv-1-s01e01', releaseId: 'a1' });
    expect(rows.map((row) => row.status)).toEqual([
      'ready',
      'loading',
      'unavailable',
      'unavailable',
    ]);
  });

  it("a pack takes each covered episode's file from the pack (the even share without a candidate)", () => {
    const pack = {
      version: { releaseId: 'pack', name: 'Show.S01.PACK' },
      offline: { playable: true, engine: 'vlc', reasons: [] },
      episodes: [1, 2],
      complete: false,
      packSizeBytes: 4 * GB,
      sizeBytes: 3 * GB,
      sizeExact: false,
      perEpisodeSizeBytes: 2 * GB,
      recommended: true,
    } as unknown as DownloadPack;
    const withPack = input();
    withPack.episodes[0]!.candidates.push(candidate('pack', { sizeBytes: GB, sizeExact: false }));
    const rows = packRows(withPack, pack);
    expect(rows.map((row) => [row.episodeNumber, row.candidate?.sizeBytes, row.selected])).toEqual([
      [1, GB, true],
      [2, 2 * GB, true],
    ]);
    const selection = selectionOf(rows);
    expect(selection).toMatchObject({ count: 2, bytes: 3 * GB, estimate: true });
    expect(requestItems(selection.rows, { seriesTitle: 'Show' })).toEqual([
      expect.objectContaining({
        workId: 'tmdb-tv-1-s01e01',
        releaseId: 'pack',
        meta: { title: 'Episode 1', seriesTitle: 'Show' },
      }),
      expect.objectContaining({
        workId: 'tmdb-tv-1-s01e02',
        releaseId: 'pack',
        candidate: { sizeBytes: 2 * GB, version: pack.version },
      }),
    ]);
  });

  it('names the subtitle hint before the engine notes', () => {
    const notes = candidateNotes({
      offline: {
        playable: true,
        reasons: [
          { code: 'vlc_fallback' },
          { code: 'container_assumed' },
          { code: 'image_subtitle_vlc' },
        ],
      },
    });
    expect(notes.map((note) => note.code)).toEqual(['image_subtitle_vlc', 'vlc_fallback']);
  });
});

describe('navigation sets', () => {
  it('phones: Library instead of Movies and Series, Downloads as its own tab (six tabs)', () => {
    const tabs = nativeTabs({ phone: true, downloads: true });
    expect(tabs.filter((tab) => !tab.hidden).map((tab) => tab.labelKey)).toEqual([
      'home',
      'search',
      'library',
      'mylist',
      'downloads',
      'settings',
    ]);
    expect(tabs.find((tab) => tab.id === 'series')?.hidden).toBe(true);
    expect(tabs.find((tab) => tab.id === 'movies')).toMatchObject({
      name: '(movies)',
      md: 'video_library',
    });
  });

  it('Apple TV keeps Movies and Series and has no Downloads', () => {
    const tabs = nativeTabs({ phone: false, downloads: false });
    expect(tabs.filter((tab) => !tab.hidden).map((tab) => tab.labelKey)).toEqual([
      'home',
      'search',
      'movies',
      'series',
      'mylist',
      'settings',
    ]);
  });

  it('a phone without the download engine has five tabs', () => {
    expect(nativeTabs({ phone: true, downloads: false }).filter((tab) => !tab.hidden)).toHaveLength(
      5
    );
  });

  it('the rail adds Downloads only where downloads exist', () => {
    expect(railTabs(true).map((tab) => tab.id)).toContain('downloads');
    expect(railTabs(false).map((tab) => tab.id)).toEqual([
      'home',
      'search',
      'movies',
      'series',
      'mylist',
      'settings',
    ]);
  });

  it('links to /movies name the Movies segment; others pass unchanged', () => {
    expect(libraryLink('/movies')).toBe('/movies?kind=movie');
    expect(libraryLink('streamarr://movies')).toBe('/movies?kind=movie');
    expect(libraryLink('/movies?genre=27')).toBe('/movies?genre=27&kind=movie');
    expect(libraryLink('/movies?kind=series')).toBe('/movies?kind=series');
    expect(libraryLink('/movie/603')).toBe('/movie/603');
    expect(libraryLink('/series')).toBe('/series');
  });
});
