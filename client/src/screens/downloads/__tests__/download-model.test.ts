import type { DownloadCandidate, DownloadPack, DownloadPlanItem, SpaceVerdict } from '@/downloads';
import { libraryLink } from '@/navigation/library-link';
import { nativeTabs, railTabs } from '@/navigation/tabs';

import {
  candidateNotes,
  defaultAnchor,
  defaultCandidate,
  eachRows,
  failureActions,
  packRows,
  packSelections,
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

  it('"rest similar" keeps the plan\'s language_differs note on its row, not on a pick of the viewer', () => {
    const plan: DownloadPlanItem[] = [
      {
        workId: 'tmdb-tv-1-s01e02',
        match: 'best_available',
        score: 40,
        candidate: candidate('b2'),
        notes: [
          { code: 'language_differs', params: { languages: 'de,en', anchorLanguages: 'untagged' } },
        ],
      },
    ];
    const anchor = { workId: 'tmdb-tv-1-s01e01', releaseId: 'a1' };
    expect(similarRows(input(), plan, anchor)[1]!.languageDiffers).toEqual(['de', 'en']);

    const untagged = [
      { ...plan[0]!, notes: [{ code: 'language_differs', params: { languages: 'untagged' } }] },
    ];
    expect(similarRows(input(), untagged, anchor)[1]!.languageDiffers).toEqual([]);

    const same = [{ ...plan[0]!, notes: [] }];
    expect(similarRows(input(), same, anchor)[1]!.languageDiffers).toBeUndefined();

    const picked = similarRows(
      input({ overrides: { 'tmdb-tv-1-s01e02': 'a2' } }),
      plan,
      anchor
    )[1]!;
    expect([picked.match, picked.languageDiffers]).toEqual(['manual', undefined]);
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

  it('names the subtitle hint first and never "the built-in player can\'t" (VLC is how it plays)', () => {
    const notes = candidateNotes({
      offline: {
        playable: true,
        reasons: [
          { code: 'vlc_fallback' },
          { code: 'container_assumed' },
          { code: 'hdr_tone_mapped' },
          { code: 'image_subtitle_vlc' },
        ],
      },
    });
    expect(notes.map((note) => note.code)).toEqual(['image_subtitle_vlc', 'hdr_tone_mapped']);
    expect(
      candidateNotes({ offline: { playable: true, reasons: [{ code: 'vlc_fallback' }] } })
    ).toEqual([]);
  });
});

describe('season selection edge cases (DL-C-verify1 C1-23)', () => {
  const pack = (episodes: number[], patch: Partial<DownloadPack> = {}): DownloadPack =>
    ({
      ...candidate('pack', { seasonPack: true }),
      episodes,
      complete: false,
      packSizeBytes: episodes.length * 2 * GB,
      perEpisodeSizeBytes: 2 * GB,
      ...patch,
    }) as unknown as DownloadPack;
  const season = (count: number, make: (n: number) => DownloadCandidate[]) =>
    Array.from({ length: count }, (_, index) => ({
      workId: `tmdb-tv-1-s01e${String(index + 1).padStart(2, '0')}`,
      episodeNumber: index + 1,
      title: `Episode ${index + 1}`,
      aired: true,
      candidates: make(index + 1),
      streamOnlyCount: 0,
    }));

  it('a partial, non-contiguous pack only lists the episodes it covers', () => {
    const rows = packRows(
      input({ episodes: season(6, (n) => [candidate(`e${n}`)]) }),
      pack([5, 1, 3])
    );
    expect(rows.map((row) => row.episodeNumber)).toEqual([1, 3, 5]);
    expect(rows.every((row) => row.candidate?.version.releaseId === 'pack')).toBe(true);
  });

  it("mixes exact sizes of the pack's own files with the even share of the rest", () => {
    const episodes = season(3, (n) =>
      n === 2 ? [candidate('pack', { sizeBytes: 1.5 * GB, sizeExact: true })] : [candidate(`e${n}`)]
    );
    const selection = selectionOf(packRows(input({ episodes }), pack([1, 2, 3])));
    expect(selection.bytes).toBe(2 * GB + 1.5 * GB + 2 * GB);
    expect(selection.estimate).toBe(true);
    const onlyExact = selectionOf(
      packRows(
        input({ episodes, deselected: new Set([episodes[0]!.workId, episodes[2]!.workId]) }),
        pack([1, 2, 3])
      )
    );
    expect(onlyExact).toMatchObject({ count: 1, bytes: 1.5 * GB, estimate: false });
  });

  it('judges every pack by the episodes it would still download', () => {
    const episodes = season(3, (n) => [candidate(`e${n}`)]);
    const a = pack([1, 2, 3]);
    const b = pack([1, 2]);
    const selections = packSelections(
      input({ episodes, existing: [{ workId: episodes[0]!.workId, state: 'done' }] }),
      [a, b]
    );
    expect(selections.get(a)).toMatchObject({ count: 2, bytes: 4 * GB });
    expect(selections.get(b)).toMatchObject({ count: 1, bytes: 2 * GB });
  });

  it('a 24-episode season with an edited plan: changed rows keep their pick, deselected ones drop out', () => {
    const episodes = season(24, (n) => [
      candidate(`a${n}`),
      candidate(`b${n}`, { sizeBytes: 3 * GB }),
    ]);
    const plan: DownloadPlanItem[] = episodes.slice(1).map((item, index) => ({
      workId: item.workId,
      match: index % 5 === 4 ? 'best_available' : 'same_variant',
      score: 1,
      candidate: item.candidates[0]!,
    }));
    const rows = similarRows(
      input({
        episodes,
        overrides: { [episodes[4]!.workId]: 'b5', [episodes[19]!.workId]: 'b20' },
        deselected: new Set([episodes[7]!.workId, episodes[8]!.workId, episodes[22]!.workId]),
      }),
      plan,
      { workId: episodes[0]!.workId, releaseId: 'a1' }
    );
    expect(rows).toHaveLength(24);
    expect(rows[0]).toMatchObject({ match: 'same_release', selected: true });
    expect(rows[4]).toMatchObject({ match: 'manual', candidate: { version: { releaseId: 'b5' } } });
    expect(rows[5]!.match).toBe('best_available');
    const selection = selectionOf(rows);
    expect(selection.count).toBe(21);
    expect(selection.bytes).toBe(19 * GB + 2 * 3 * GB);
  });

  it('the default anchor starts at the episode the viewer came from and needs a version that fits', () => {
    const episodes = season(4, (n) => [candidate(`e${n}`, { fits: n !== 3, recommended: true })]);
    expect(defaultAnchor(episodes, episodes[2]!.workId, new Set())).toEqual({
      workId: episodes[3]!.workId,
      releaseId: 'e4',
    });
    expect(defaultAnchor(episodes, episodes[3]!.workId, new Set([episodes[3]!.workId]))).toEqual({
      workId: episodes[0]!.workId,
      releaseId: 'e1',
    });
    const nothingFits = season(2, (n) => [candidate(`e${n}`, { fits: false })]);
    expect(defaultAnchor(nothingFits, null, new Set())).toBeUndefined();
  });

  it('a failed episode is ready again and keeps its reason', () => {
    const error = { code: 'release_dead', actions: ['otherVersion'], at: 0 };
    const [row] = eachRows(
      input({
        episodes: [episode(1, [candidate('a1', { recommended: true })])],
        existing: [{ workId: 'tmdb-tv-1-s01e01', state: 'failed', error }],
      })
    );
    expect(row).toMatchObject({
      status: 'ready',
      selected: true,
      failedBefore: true,
      failedError: error,
    });
  });
});

describe('failureActions', () => {
  it('offers what the failure lists; none listed means retry', () => {
    const failed = (actions?: string[]) => ({
      state: 'failed' as const,
      error: { code: 'x', actions, at: 0 },
    });
    expect(failureActions(failed())).toEqual({ retry: true, otherVersion: false });
    expect(failureActions(failed(['otherVersion']))).toEqual({ retry: false, otherVersion: true });
    expect(failureActions(failed(['retry', 'remove']))).toEqual({
      retry: true,
      otherVersion: false,
    });
    // Held back by the profile's rights: nothing to retry or swap, also for a record without actions.
    for (const code of ['downloads_not_allowed', 'age_restricted'])
      expect(
        failureActions({ state: 'failed', error: { code, actions: undefined, at: 0 } })
      ).toEqual({ retry: false, otherVersion: false });
    expect(failureActions({ state: 'done', error: null })).toEqual({
      retry: false,
      otherVersion: false,
    });
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
