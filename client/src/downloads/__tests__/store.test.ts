import { createFakeDownloadEngine } from '@/downloads/engine/fake';

import { fakeOfflineDownload } from '../../../jest/downloads';

import {
  accountFolder,
  downloadAccountKey,
  downloadFolder,
  filePathOf,
  newDownloadId,
  safeFileName,
  workPartsOf,
} from '../keys';
import { groupLibrary, isFinishedRow, spaceVerdict } from '../library';
import { resumeSecondsOf } from '../local-play';
import { isActiveDownload, isRemovingDownload, remainingBytes } from '../manager';
import {
  createMemoryDownloadsStorage,
  DOWNLOADS_SCHEMA,
  DownloadStore,
  normalizeDownload,
  PROGRESS_WRITE_MS,
} from '../store';

describe('download store', () => {
  it('writes the schema version and keeps records per owner prefix', () => {
    const storage = createMemoryDownloadsStorage();
    const store = new DownloadStore({ storage });
    expect(storage.getString('schema')).toBe(String(DOWNLOADS_SCHEMA));
    store.put(fakeOfflineDownload({ id: 'a', accountKey: 'http://x#v1' }));
    store.put(fakeOfflineDownload({ id: 'b', accountKey: 'http://x#v2', workId: 'tmdb-movie-2' }));
    expect(storage.getAllKeys().filter((key) => key.startsWith('d/'))).toEqual([
      `d/${accountFolder('http://x#v1')}/a`,
      `d/${accountFolder('http://x#v2')}/b`,
    ]);
    expect(new DownloadStore({ storage }).forAccount('http://x#v2').map((d) => d.id)).toEqual([
      'b',
    ]);
  });

  it('fills fields an older or newer version did not write and drops unusable records', () => {
    const storage = createMemoryDownloadsStorage({
      schema: '1',
      'd/x/old': JSON.stringify({
        id: 'old',
        accountKey: 'k',
        workId: 'tmdb-movie-1',
        releaseId: 'r',
        state: 'downloading',
        createdAt: 5,
      }),
      'd/x/future': JSON.stringify({
        ...fakeOfflineDownload({ id: 'future' }),
        state: 'teleporting',
        extra: true,
      }),
      'd/x/broken': '{nope',
      'd/x/empty': JSON.stringify({ id: 'empty' }),
    });
    const store = new DownloadStore({ storage });
    expect(store.get('old')).toMatchObject({
      state: 'downloading',
      bytesWritten: 0,
      volumeId: 'internal',
      restarts: 0,
      meta: { title: '' },
      updatedAt: 5,
    });
    expect(store.get('future')).toMatchObject({ state: 'failed', error: { code: 'unknown' } });
    expect(
      store
        .all()
        .map((d) => d.id)
        .sort()
    ).toEqual(['future', 'old']);
    expect(storage.getString('d/x/broken')).toBeUndefined();
    expect(normalizeDownload(null)).toBeNull();
  });

  it('keeps progress in memory and writes it on a timer or flush', () => {
    jest.useFakeTimers();
    const storage = createMemoryDownloadsStorage();
    const store = new DownloadStore({ storage });
    store.put(fakeOfflineDownload({ id: 'p', state: 'downloading', bytesWritten: 0 }));
    store.update('p', { bytesWritten: 10 }, { persist: false });
    expect(new DownloadStore({ storage }).get('p')!.bytesWritten).toBe(0);
    jest.advanceTimersByTime(PROGRESS_WRITE_MS);
    expect(new DownloadStore({ storage }).get('p')!.bytesWritten).toBe(10);
    store.update('p', { bytesWritten: 20 }, { persist: false });
    store.flush();
    expect(new DownloadStore({ storage }).get('p')!.bytesWritten).toBe(20);
    jest.useRealTimers();
  });

  it('notifies subscribers with a new snapshot array', () => {
    const store = new DownloadStore({ storage: createMemoryDownloadsStorage() });
    const before = store.all();
    const listener = jest.fn();
    store.subscribe(listener);
    store.put(fakeOfflineDownload({ id: 'n' }));
    expect(listener).toHaveBeenCalled();
    expect(store.all()).not.toBe(before);
    expect(store.all()).toBe(store.all());
  });

  it('stores positions, settings, pending deletes and a stable install id', () => {
    const storage = createMemoryDownloadsStorage();
    const store = new DownloadStore({ storage, newInstallId: () => 'install-1' });
    store.setPosition('k', 'w', { seconds: 30, durationSeconds: 60, at: 1, played: false });
    expect(store.position('k', 'w')?.seconds).toBe(30);
    expect(store.position('other', 'w')).toBeNull();
    expect(store.settings()).toEqual({ wifiOnly: true, maxConcurrent: 2, deleteWatched: false });
    store.setSettings({ wifiOnly: false });
    expect(new DownloadStore({ storage }).settings().wifiOnly).toBe(false);
    store.setPendingDeletes([{ accountKey: 'k', downloadId: 's' }]);
    expect(new DownloadStore({ storage }).pendingDeletes()).toHaveLength(1);
    expect(store.installId()).toBe('install-1');
    // The default id is one stable device for the server: ASCII, lowercase, no spaces, persisted.
    const fresh = createMemoryDownloadsStorage();
    const generated = new DownloadStore({ storage: fresh }).installId();
    expect(generated).toMatch(/^[a-z0-9]{8,64}$/);
    expect(new DownloadStore({ storage: fresh }).installId()).toBe(generated);
    expect(new DownloadStore({ storage, newInstallId: () => 'other' }).installId()).toBe(
      'install-1'
    );
  });
});

describe('download keys and helpers', () => {
  it('owns downloads by server and viewer, independent of the local account id', () => {
    expect(downloadAccountKey({ serverUrl: 'HTTP://LocalHost:8080/', viewerId: 'v1' })).toBe(
      'http://127.0.0.1:8080#v1'
    );
    expect(accountFolder('a#b')).toMatch(/^a[0-9a-f]{16}$/);
  });

  it('derives series and season of an episode work id', () => {
    expect(workPartsOf('tmdb-tv-1396-s02e03')).toEqual({
      kind: 'episode',
      seriesId: 'tmdb-tv-1396',
      seasonId: 'tmdb-tv-1396-s02',
      seasonNumber: 2,
      episodeNumber: 3,
    });
    expect(workPartsOf('tmdb-movie-1')?.kind).toBe('movie');
    expect(workPartsOf('tmdb-tv-1396')).toBeNull();
  });

  it('keeps file names path safe', () => {
    expect(safeFileName('../a/b:c?.mkv', 'x')).toBe('_a_b_c_.mkv');
    expect(safeFileName('', 'fallback.bin')).toBe('fallback.bin');
    expect(safeFileName('Movie.mkv.PART', 'x')).toBe('Movie.mkv.PART_');
    expect(filePathOf('k', 'd1', 'Movie.mkv')).toBe(`${accountFolder('k')}/d1/Movie.mkv`);
    // The engine refuses targets ending in `.part` (its staging suffix): a server name never produces one.
    for (const name of ['Movie.mkv.part', 'MOVIE.PART', '.part', null])
      expect(filePathOf('k', 'd1', name)).not.toMatch(/\.part$/i);
  });

  it('N8-03: a media name never takes the place of what the core puts next to it (the artwork folder)', () => {
    const folder = downloadFolder('k', 'd1');
    const siblings = [`${folder}/art`];
    for (const name of [
      'art',
      'ART',
      'Art',
      'Art.',
      'art ',
      ' aRt . ',
      'art...',
      '/art',
      '..art',
    ]) {
      const path = filePathOf('k', 'd1', name);
      for (const sibling of siblings) {
        // The comparison a case-insensitive file system makes (APFS, FAT/exFAT drop trailing dots and spaces).
        const fold = (value: string) => value.toLowerCase().replace(/[. ]+$/, '');
        expect(fold(path)).not.toBe(fold(sibling));
        expect(fold(path).startsWith(`${fold(sibling)}/`)).toBe(false);
      }
      expect(path.startsWith(`${folder}/`)).toBe(true);
      expect(path).not.toMatch(/[. ]$/);
    }
    expect(filePathOf('k', 'd1', 'ART')).toBe(`${folder}/ART_media`);
    expect(filePathOf('k', 'd1', 'Art.')).toBe(`${folder}/Art_media`);
    // Names that only contain it stay as they are.
    for (const name of ['art.mkv', 'Art of War.mkv', 'artwork', 'cart', 'art_media', 'art.part'])
      expect(safeFileName(name, 'x')).toBe(name === 'art.part' ? 'art.part_' : name);
    expect(filePathOf('k', 'd1', 'Movie.mkv')).toBe(`${folder}/Movie.mkv`);
  });

  it('N8-03: a record stored with such a path before keeps it (only new downloads are named anew)', async () => {
    const storage = createMemoryDownloadsStorage();
    const store = new DownloadStore({ storage });
    const legacy = fakeOfflineDownload({
      id: 'legacy',
      relativePath: `${downloadFolder('k', 'legacy')}/art`,
    });
    store.put(legacy);
    store.flush();
    expect(new DownloadStore({ storage }).get('legacy')?.relativePath).toBe(legacy.relativePath);
  });

  it('never builds a path segment ending in a dot or space, which the engine refuses (N3-03)', async () => {
    const id = newDownloadId();
    const key = downloadAccountKey({ serverUrl: 'http://dev.test', viewerId: 'v-anna' });
    const names = [
      'Movie.',
      'Movie. ',
      'Movie.mkv...',
      '...',
      '   ',
      `${'a'.repeat(150)}.mkv${'.'.repeat(46)}`,
      'x.part.',
      'Movie . . ',
    ];
    const engine = createFakeDownloadEngine();
    for (const name of names) {
      const path = filePathOf(key, id, name);
      for (const segment of path.split('/')) expect(segment).not.toMatch(/(^$|[. ]$)/);
      expect(path).not.toMatch(/\.part$/i);
      // The engine is the judge: it accepts every one of them.
      await expect(
        engine.start({
          id: `t${names.indexOf(name)}`,
          url: 'http://dev.test/f',
          relativePath: path,
        })
      ).resolves.toMatchObject({ relativePath: path });
      await engine.cancel(`t${names.indexOf(name)}`);
    }
    expect(filePathOf(key, id, '...')).toBe(`${downloadFolder(key, id)}/${id}.bin`);
    expect(filePathOf(key, id, '   ')).toBe(`${downloadFolder(key, id)}/${id}.bin`);
    expect(filePathOf(key, id, 'x.part.')).toMatch(/\/x\.part_$/);
    expect(filePathOf(key, id, `${'a'.repeat(150)}.mkv${'.'.repeat(46)}`)).toMatch(/\/a{70}\.mkv$/);
  });

  it('groups the library and judges space', () => {
    const library = groupLibrary('k', [
      fakeOfflineDownload({
        id: 'm',
        accountKey: 'k',
        workId: 'tmdb-movie-1',
        meta: { title: 'B' },
      }),
      fakeOfflineDownload({
        id: 'e2',
        accountKey: 'k',
        workId: 'tmdb-tv-5-s01e02',
        meta: { title: 'Two', seriesTitle: 'Show' },
      }),
      fakeOfflineDownload({
        id: 'e1',
        accountKey: 'k',
        workId: 'tmdb-tv-5-s01e01',
        state: 'downloading',
        meta: { title: 'One', seriesTitle: 'Show' },
      }),
      fakeOfflineDownload({ id: 'x', accountKey: 'other' }),
    ]);
    expect(library.movies.map((d) => d.id)).toEqual(['m']);
    expect(library.series[0]!.seasons[0]!.episodes.map((d) => d.id)).toEqual(['e1', 'e2']);
    expect(library.active.map((d) => d.id)).toEqual(['e1']);
    expect(spaceVerdict(5, 3, true)).toEqual({
      fits: false,
      neededBytes: 5,
      availableBytes: 3,
      missingBytes: 2,
      estimate: true,
    });
  });

  it('resumes at the newer of the local and the server position', () => {
    const local = { seconds: 100, durationSeconds: 600, at: 2_000, played: false };
    expect(resumeSecondsOf(local, { seconds: 50, at: 1_000 })).toBe(100);
    expect(resumeSecondsOf(local, { seconds: 300, at: 3_000 })).toBe(300);
    expect(resumeSecondsOf(local, null)).toBe(100);
    expect(resumeSecondsOf({ ...local, played: true }, null)).toBe(0);
    expect(resumeSecondsOf(null, { seconds: 70, at: null })).toBe(0);
  });
});

describe('removing state (DL decision)', () => {
  it('survives the store, is never active, never counted and needs no space', () => {
    const storage = createMemoryDownloadsStorage();
    const store = new DownloadStore({ storage });
    const removing = fakeOfflineDownload({
      id: 'r',
      state: 'removing',
      sizeBytes: 1000,
      bytesWritten: 400,
    });
    store.put(removing);
    const reloaded = new DownloadStore({ storage }).get('r')!;
    expect(reloaded.state).toBe('removing');
    expect(isRemovingDownload(reloaded)).toBe(true);
    expect(isActiveDownload(reloaded)).toBe(false);
    expect(remainingBytes(reloaded)).toBe(0);
    // Its row stays where it was (unfinished: in progress), but nothing counts it.
    const library = groupLibrary(reloaded.accountKey, [reloaded]);
    expect(library.active.map((download) => download.id)).toEqual(['r']);
    expect(library.active.filter(isActiveDownload)).toEqual([]);
    expect(library.bytes).toBe(0);
    const finished = { ...reloaded, completedAt: 5 };
    expect(isFinishedRow(finished)).toBe(true);
    expect(groupLibrary(finished.accountKey, [finished]).active).toEqual([]);
  });
});
