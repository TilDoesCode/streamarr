import { userEvent, within } from '@testing-library/react-native';
import { act, screen, waitFor } from 'expo-router/testing-library';

import { clearWorld, GB, json, open, resetWorld, WAIT, world } from '@/../jest/downloads-ui-world';
import { deviceSettings } from '@/lib/storage';

// Phone tests override the window (the jest default is tablet-sized).
let mockWindow: { width: number; height: number; scale: number; fontScale: number } | undefined;
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => {
  const actual = jest.requireActual('react-native/Libraries/Utilities/useWindowDimensions');
  return { __esModule: true, default: () => mockWindow ?? actual.default() };
});
const PHONE = { width: 390, height: 844, scale: 3, fontScale: 1 };

const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

const seed = [
  { workId: 'tmdb-movie-123', meta: { title: 'Sintel' } },
  { workId: 'tmdb-tv-7-s01e01', meta: { title: 'Pilot', seriesTitle: 'Sherlock' } },
  {
    workId: 'tmdb-tv-7-s01e02',
    state: 'downloading' as const,
    bytesWritten: GB / 2,
    completedAt: null,
    meta: { title: 'Second', seriesTitle: 'Sherlock' },
  },
];

afterEach(() => {
  mockWindow = undefined;
  clearWorld();
});

describe('Downloads screen and rail entry', () => {
  beforeEach(() => resetWorld(seed));

  it('the rail has Downloads with a badge of running downloads; the screen lists them', async () => {
    await open('/downloads');
    expect(await screen.findByTestId('nav-downloads', {}, WAIT)).toBeOnTheScreen();
    expect(screen.getByTestId('downloads-badge')).toHaveTextContent('1');
    expect(screen.getByTestId('downloads-badge')).toHaveProp(
      'accessibilityLabel',
      '1 download running'
    );
    expect(screen.getByTestId('downloads-summary')).toHaveTextContent(/^3 downloads · /);
    expect(screen.getByTestId('download-series-tmdb-tv-7')).toHaveTextContent(/Sherlock/);
    expect(screen.getByTestId('downloads-active')).toHaveTextContent(/Second/);
    expect(screen.getByTestId('downloads-movies')).toHaveTextContent(/Sintel/);
    expect(await screen.findByTestId('downloads-storage', {}, WAIT)).toBeOnTheScreen();
  });

  it('pauses every running download and deletes watched ones after asking', async () => {
    await open('/downloads');
    const user = userEvent.setup();
    const pause = jest.spyOn(world.downloads!.manager, 'pause');
    const removeWatched = jest.spyOn(world.downloads!.manager, 'removeWatched');
    await user.press(await screen.findByTestId('downloads-pause-all', {}, WAIT));
    expect(pause).toHaveBeenCalledTimes(1);
    await user.press(screen.getByTestId('downloads-remove-watched'));
    await user.press(await screen.findByTestId('downloads-remove-watched-confirm', {}, WAIT));
    expect(removeWatched).toHaveBeenCalledWith('http://dev.test#v-anna');
  });

  it('plays a finished download from the list (the player picks the file)', async () => {
    const { router } = await open('/downloads');
    await userEvent
      .setup()
      .press(await screen.findByTestId('download-tmdb-movie-123-open', {}, WAIT));
    await waitFor(() => expect(router.getPathname()).toBe('/play/new'));
    expect(router.getSearchParams()).toMatchObject({ workId: 'tmdb-movie-123', title: 'Sintel' });
    expect(router.getSearchParams().releaseId).toBeUndefined();
  });

  it('keeps the downloads watchable when the admin turned downloads off', async () => {
    world.handlers['/api/v1/viewer/me'] = () =>
      json(200, { id: 'v-anna', username: 'anna', permissions: { allowDownloads: false } });
    await open('/downloads');
    expect(await screen.findByTestId('downloads-not-allowed', {}, WAIT)).toHaveTextContent(
      /new ones can’t be started/
    );
    expect(screen.getByTestId('downloads-movies')).toBeOnTheScreen();
  });
});

describe('failed downloads in the list (error.actions)', () => {
  it('"Other version" opens the download sheet for that work; retry only where offered', async () => {
    await resetWorld([
      {
        workId: 'tmdb-movie-123',
        state: 'failed',
        completedAt: null,
        meta: { title: 'Sintel' },
        error: { code: 'release_dead', actions: ['otherVersion'], at: 0 },
      },
      {
        workId: 'tmdb-tv-7-s01e01',
        state: 'failed',
        completedAt: null,
        meta: { title: 'Pilot', seriesTitle: 'Sherlock' },
        error: { code: 'network', at: 0 },
      },
    ]);
    const { router } = await open('/downloads');
    await screen.findByTestId('download-tmdb-movie-123-other-version', {}, WAIT);
    expect(screen.queryByTestId('download-tmdb-movie-123-retry')).toBeNull();
    expect(screen.queryByTestId('download-tmdb-movie-123-pause')).toBeNull();
    expect(screen.getByTestId('download-tmdb-tv-7-s01e01-retry')).toBeOnTheScreen();
    expect(screen.queryByTestId('download-tmdb-tv-7-s01e01-other-version')).toBeNull();
    await userEvent.setup().press(screen.getByTestId('download-tmdb-movie-123-other-version'));
    await waitFor(() => expect(router.getPathname()).toBe('/download/tmdb-movie-123'));
    expect(router.getSearchParams()).toMatchObject({ title: 'Sintel' });
  });
});

describe('policy refusals and sign-in waits in the list', () => {
  it('a refused download offers only delete; one waiting for sign-in says so, without retry', async () => {
    await resetWorld([
      {
        workId: 'tmdb-movie-123',
        state: 'failed',
        completedAt: null,
        meta: { title: 'Sintel' },
        error: { code: 'downloads_not_allowed', actions: ['remove'], status: 403, at: 0 },
      },
      {
        // An older record: refused before the core listed actions.
        workId: 'tmdb-movie-456',
        state: 'failed',
        completedAt: null,
        meta: { title: 'Tears of Steel' },
        error: { code: 'downloads_not_allowed', status: 403, at: 0 },
      },
      {
        workId: 'tmdb-tv-7-s01e01',
        state: 'waiting_server',
        completedAt: null,
        retryAt: Date.now() + 600_000,
        meta: { title: 'Pilot', seriesTitle: 'Sherlock' },
        error: { code: 'signed_out', at: 0 },
      },
    ]);
    await open('/downloads');
    await screen.findByTestId('download-tmdb-movie-123-delete', {}, WAIT);
    const refused = screen.getByTestId('download-tmdb-movie-123');
    expect(
      within(refused).getByText('Downloads are off for now – resumes on its own once allowed')
    ).toBeOnTheScreen();
    expect(within(refused).getByText(/^On hold/)).toBeOnTheScreen();
    expect(within(refused).queryByText(/^Failed/)).toBeNull();
    expect(screen.queryByTestId('download-tmdb-movie-123-retry')).toBeNull();
    expect(screen.queryByTestId('download-tmdb-movie-123-other-version')).toBeNull();
    expect(screen.queryByTestId('download-tmdb-movie-456-retry')).toBeNull();
    expect(screen.queryByTestId('download-tmdb-movie-456-other-version')).toBeNull();
    expect(screen.getByText(/Continues after you sign in again/)).toBeOnTheScreen();
    expect(screen.queryByText(/Sign in to this profile again/)).toBeNull();
    expect(screen.queryByTestId('download-tmdb-tv-7-s01e01-retry')).toBeNull();
  });
});

describe('downloads on storage that is not connected', () => {
  it('a finished one says so without Play; a waiting one offers no retry', async () => {
    await resetWorld([
      {
        workId: 'tmdb-movie-123',
        volumeId: 'volume-1234',
        meta: { title: 'Sintel' },
        error: { code: 'volume_unavailable', at: 0 },
      },
      {
        workId: 'tmdb-movie-456',
        state: 'waiting_volume',
        completedAt: null,
        volumeId: 'volume-1234',
        meta: { title: 'Tears of Steel' },
        error: { code: 'volume_unavailable', at: 0 },
      },
    ]);
    await open('/downloads');
    const done = await screen.findByTestId('download-tmdb-movie-123', {}, WAIT);
    expect(within(done).getByText(/isn’t connected right now/)).toBeOnTheScreen();
    expect(screen.queryByTestId('download-tmdb-movie-123-play')).toBeNull();
    expect(screen.getByTestId('download-tmdb-movie-123-delete')).toBeOnTheScreen();
    const waiting = screen.getByTestId('download-tmdb-movie-456');
    expect(within(waiting).getByText(/^Storage not available/)).toBeOnTheScreen();
    expect(screen.queryByTestId('download-tmdb-movie-456-retry')).toBeNull();
  });
});

describe('a download being removed (the engine ends the transfer first)', () => {
  it('keeps its place greyed, says "Removing…" after a moment, has no actions and leaves the badge', async () => {
    await resetWorld([
      {
        workId: 'tmdb-movie-123',
        state: 'downloading',
        completedAt: null,
        sizeBytes: 1000,
        bytesWritten: 300,
        meta: { title: 'Sintel' },
      },
      { workId: 'tmdb-movie-456', state: 'done', meta: { title: 'Tears of Steel' } },
    ]);
    await open('/downloads');
    await screen.findByTestId('download-tmdb-movie-123-pause', {}, WAIT);
    expect(screen.getByTestId('downloads-badge')).toHaveTextContent('1');
    const store = world.downloads!.store;
    await act(async () => {
      for (const download of store.all()) store.update(download.id, { state: 'removing' });
    });
    // At once: greyed in place, no actions, no label yet (a fast delete only flickers grey).
    expect(
      within(screen.getByTestId('downloads-active')).getByTestId('download-tmdb-movie-123')
    ).toBeOnTheScreen();
    expect(
      within(screen.getByTestId('downloads-movies')).getByTestId('download-tmdb-movie-456')
    ).toBeOnTheScreen();
    for (const action of ['pause', 'retry', 'delete', 'play', 'open'])
      for (const work of ['tmdb-movie-123', 'tmdb-movie-456'])
        expect(screen.queryByTestId(`download-${work}-${action}`)).toBeNull();
    expect(screen.queryByText('Removing…')).toBeNull();
    expect(screen.queryByTestId('downloads-badge')).toBeNull();
    await waitFor(() => expect(screen.getAllByText('Removing…')).toHaveLength(2), WAIT);
    // Gone once the engine confirmed and the core deleted the record.
    await act(async () => {
      for (const download of store.all()) store.delete(download.id);
    });
    await waitFor(() => expect(screen.queryByTestId('download-tmdb-movie-123')).toBeNull(), WAIT);
    expect(screen.queryByTestId('download-tmdb-movie-456')).toBeNull();
  });
});

describe('Downloads screen states', () => {
  it('is empty with a hint where to start', async () => {
    await resetWorld();
    await open('/downloads');
    expect(await screen.findByTestId('downloads-empty', {}, WAIT)).toHaveTextContent(
      /No downloads yet/
    );
  });

  it('has no rail entry and explains itself where downloads do not exist', async () => {
    await resetWorld();
    world.downloads = null;
    await open('/downloads');
    expect(await screen.findByTestId('downloads-unsupported', {}, WAIT)).toBeOnTheScreen();
    expect(screen.queryByTestId('nav-downloads')).toBeNull();
    expect(screen.getByTestId('nav-movies')).toBeOnTheScreen();
  });
});

describe('Settings → Downloads', () => {
  beforeEach(() => resetWorld(seed));

  it('switches Wi-Fi only, downloads at once and delete-watched, and deletes all after asking', async () => {
    await open('/settings');
    const user = userEvent.setup();
    const manager = world.downloads!.manager;
    const wifi = jest.spyOn(manager, 'setWifiOnly');
    const concurrent = jest.spyOn(manager, 'setMaxConcurrent');
    const watched = jest.spyOn(manager, 'setDeleteWatched');
    const removeAll = jest.spyOn(manager, 'removeAll');
    expect(await screen.findByTestId('settings-downloads', {}, WAIT)).toBeOnTheScreen();
    expect(screen.getByTestId('settings-downloads-wifi-on')).toBeChecked();
    expect(screen.getByTestId('settings-downloads-concurrent-2')).toBeChecked();
    expect(screen.getByTestId('settings-downloads-delete-watched-off')).toBeChecked();
    await user.press(screen.getByTestId('settings-downloads-wifi-off'));
    expect(wifi).toHaveBeenCalledWith(false);
    await user.press(screen.getByTestId('settings-downloads-concurrent-3'));
    expect(concurrent).toHaveBeenCalledWith(3);
    await user.press(screen.getByTestId('settings-downloads-delete-watched-on'));
    expect(watched).toHaveBeenCalledWith(true);
    await waitFor(() =>
      expect(screen.getByTestId('settings-downloads-delete-watched-on')).toBeChecked()
    );
    await user.press(screen.getByTestId('settings-downloads-remove-all'));
    const dialog = await screen.findByTestId('settings-downloads-remove-all-dialog', {}, WAIT);
    expect(dialog).toHaveTextContent(/3 downloads/);
    await user.press(screen.getByTestId('settings-downloads-remove-all-confirm'));
    expect(removeAll).toHaveBeenCalledWith('http://dev.test#v-anna');
  });

  it('opens the Downloads screen', async () => {
    const { router } = await open('/settings');
    await userEvent.setup().press(await screen.findByTestId('settings-downloads-open', {}, WAIT));
    await waitFor(() => expect(router.getPathname()).toBe('/downloads'));
  });

  it('is not there where downloads do not exist', async () => {
    world.downloads = null;
    await open('/settings');
    expect(await screen.findByTestId('settings-playback', {}, WAIT)).toBeOnTheScreen();
    expect(screen.queryByTestId('settings-downloads')).toBeNull();
  });
});

describe('phone Library tab', () => {
  beforeEach(async () => {
    await resetWorld();
    deviceSettings.remove('library.kind');
    world.handlers['/api/v1/viewer/catalog/genres'] = () => json(200, { genres: [] });
    world.handlers['/api/v1/viewer/catalog/library'] = () =>
      json(200, { items: [], page: 1, hasMore: false });
  });

  it('shows "Library" with a Movies | Series switch and remembers the choice', async () => {
    mockWindow = PHONE;
    await open('/movies');
    expect(await screen.findByTestId('library-kind-movie', {}, WAIT)).toBeChecked();
    expect(screen.getByRole('heading', { name: 'Library' })).toBeOnTheScreen();
    expect(screen.getByTestId('library-movie')).toBeOnTheScreen();
    await userEvent.setup().press(screen.getByTestId('library-kind-series'));
    expect(await screen.findByTestId('library-series', {}, WAIT)).toBeOnTheScreen();
    expect(deviceSettings.getString('library.kind')).toBe('series');
  });

  it('opens on the remembered segment, a link names its own', async () => {
    mockWindow = PHONE;
    deviceSettings.set('library.kind', 'series');
    await open('/movies');
    expect(await screen.findByTestId('library-kind-series', {}, WAIT)).toBeChecked();
    clearWorld();
    await resetWorld();
    deviceSettings.set('library.kind', 'series');
    await open('/movies?kind=movie');
    expect(await screen.findByTestId('library-kind-movie', {}, WAIT)).toBeChecked();
  });

  it('keeps Movies and Series apart in the large shell', async () => {
    await open('/movies');
    expect(await screen.findByTestId('library-movie', {}, WAIT)).toBeOnTheScreen();
    expect(screen.queryByTestId('library-kind')).toBeNull();
    expect(screen.getByTestId('nav-series')).toBeOnTheScreen();
  });
});
