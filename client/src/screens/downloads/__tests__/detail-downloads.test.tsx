import { userEvent, within } from '@testing-library/react-native';
import { screen, waitFor } from 'expo-router/testing-library';

import {
  clearWorld,
  GB,
  open,
  resetWorld,
  version,
  WAIT,
  world,
} from '@/../jest/downloads-ui-world';

// Phone tests override the window (the jest default is tablet-sized).
let mockWindow: { width: number; height: number; scale: number; fontScale: number } | undefined;
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => {
  const actual = jest.requireActual('react-native/Libraries/Utilities/useWindowDimensions');
  return { __esModule: true, default: () => mockWindow ?? actual.default() };
});
const PHONE = { width: 390, height: 844, scale: 3, fontScale: 1 };

// expo-router/testing-library installs its own Reanimated mock, which lacks useReducedMotion and makeMutable.
const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

const downloaded2160 = {
  workId: 'tmdb-movie-123',
  releaseId: 'r2',
  sourceReleaseId: 'r2',
  version: version(2, { recommended: false }) as never,
  meta: { title: 'Sintel' },
};

afterEach(() => {
  mockWindow = undefined;
  clearWorld();
});

describe('movie detail with a finished download', () => {
  beforeEach(() => resetWorld([downloaded2160]));

  it('large: the chip row leads with "Downloaded" and Play starts the file (no version)', async () => {
    const { router } = await open('/movie/123');
    const chip = await screen.findByTestId('play-chips-downloaded', {}, WAIT);
    expect(chip).toHaveTextContent('Downloaded');
    expect(screen.getByTestId('play-chips-resolution')).toHaveTextContent(/2160p|4K/);
    expect(screen.getByTestId('play-chips-reasons')).toHaveTextContent(
      'Plays from this device, without the server'
    );
    expect(screen.getByTestId('movie-download')).toHaveProp(
      'accessibilityLabel',
      'Download: Downloaded'
    );
    await userEvent.setup().press(screen.getByTestId('movie-play'));
    await waitFor(() => expect(router.getPathname()).toBe('/play/new'));
    expect(router.getSearchParams().releaseId).toBeUndefined();
  });

  it('the version sheet lists the downloaded version first, marked and focused; another one streams', async () => {
    const { router } = await open('/movie/123');
    await screen.findByTestId('play-chips-downloaded', {}, WAIT);
    await userEvent.setup().press(await screen.findByTestId('movie-versions', {}, WAIT));
    const entry = await screen.findByTestId('version-sheet-entry', {}, WAIT);
    expect(within(entry).getByTestId('version-2-on-device')).toHaveTextContent('On this device');
    expect(screen.queryByTestId('version-1-on-device')).toBeNull();
    await userEvent.setup().press(screen.getByTestId('version-1'));
    await waitFor(() => expect(router.getPathname()).toBe('/play/new'));
    expect(router.getSearchParams().releaseId).toBe('r1');
  });

  it('phone: the version card says "Downloaded" / "On this device", the action row too', async () => {
    mockWindow = PHONE;
    await open('/movie/123');
    expect(await screen.findByTestId('versions-summary-downloaded', {}, WAIT)).toHaveTextContent(
      'Downloaded'
    );
    expect(screen.getByTestId('versions-summary-on-device')).toHaveTextContent('On this device');
    expect(screen.getByTestId('movie-download')).toHaveTextContent('Downloaded');
  });

  it('keeps Play when the server lists no version any more', async () => {
    world.handlers['/api/v1/viewer/catalog/works/tmdb-movie-123/versions'] = () =>
      new Response(JSON.stringify({ workId: 'tmdb-movie-123', versions: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    await open('/movie/123');
    expect(await screen.findByTestId('movie-play', {}, WAIT)).toBeOnTheScreen();
    expect(screen.queryByTestId('movie-no-versions')).toBeNull();
  });
});

describe('movie detail without a download', () => {
  beforeEach(() => resetWorld());

  it('offers "Download", which opens the download sheet', async () => {
    const { router } = await open('/movie/123');
    const button = await screen.findByTestId('movie-download', {}, WAIT);
    expect(button).toHaveProp('accessibilityLabel', 'Download');
    await userEvent.setup().press(button);
    await waitFor(() => expect(router.getPathname()).toBe('/download/tmdb-movie-123'));
    expect(router.getSearchParams()).toMatchObject({ title: 'Sintel' });
  });
});

describe('movie detail when the admin turned downloads off', () => {
  beforeEach(() => resetWorld());

  it('shows a locked entry that still opens the sheet (which explains it)', async () => {
    world.handlers['/api/v1/viewer/me'] = () =>
      new Response(
        JSON.stringify({ id: 'v-anna', username: 'anna', permissions: { allowDownloads: false } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    const { router } = await open('/movie/123');
    await waitFor(
      () =>
        expect(screen.getByTestId('movie-download')).toHaveProp(
          'accessibilityLabel',
          'Download: Downloads off'
        ),
      WAIT
    );
    await userEvent.setup().press(screen.getByTestId('movie-download'));
    await waitFor(() => expect(router.getPathname()).toBe('/download/tmdb-movie-123'));
  });
});

describe('a running download on the detail page', () => {
  beforeEach(() =>
    resetWorld([
      {
        ...downloaded2160,
        state: 'downloading',
        sizeBytes: 2 * GB,
        bytesWritten: GB / 2,
        completedAt: null,
      },
    ])
  );

  it('shows its progress with pause and cancel; pause and resume act on the download', async () => {
    await open('/movie/123');
    const card = await screen.findByTestId('detail-download', {}, WAIT);
    expect(within(card).getByTestId('detail-download-line')).toHaveTextContent(/of 2\.1 GB/);
    expect(screen.queryByTestId('play-chips-downloaded')).toBeNull();
    const [download] = world.downloads!.store.all();
    const pause = jest.spyOn(world.downloads!.manager, 'pause');
    await userEvent.setup().press(screen.getByTestId('detail-download-pause'));
    expect(pause).toHaveBeenCalledWith(download!.id);
    expect(screen.getByTestId('detail-download-remove')).toHaveProp(
      'accessibilityLabel',
      'Cancel the download of Sintel'
    );
  });
});

describe('a failed download on the detail page', () => {
  beforeEach(() =>
    resetWorld([
      {
        ...downloaded2160,
        state: 'failed',
        completedAt: null,
        error: { code: 'download_source_gone', actions: ['otherVersion'], at: 0 },
      },
    ])
  );

  it('says why and offers another version (the download sheet)', async () => {
    const { router } = await open('/movie/123');
    const card = await screen.findByTestId('detail-download', {}, WAIT);
    expect(within(card).getByTestId('detail-download-reason').props.children).toBeTruthy();
    await userEvent.setup().press(screen.getByTestId('detail-download-other-version'));
    await waitFor(() => expect(router.getPathname()).toBe('/download/tmdb-movie-123'));
    expect(router.getSearchParams()).toMatchObject({ title: 'Sintel' });
  });
});

describe('a download the age limit now locks', () => {
  it('shows a lock instead of "Downloaded" and Play streams (no local default)', async () => {
    await resetWorld([{ ...downloaded2160, meta: { title: 'Sintel', minimumAge: 16 } as never }]);
    world.downloads!.store.setPolicy('http://dev.test#v-anna', {
      maxAge: 12,
      blockUnrated: false,
      allowDownloads: true,
      at: Date.now(),
    });
    await open('/movie/123');
    await waitFor(
      () =>
        expect(screen.getByTestId('movie-download')).toHaveProp(
          'accessibilityLabel',
          'Download: Locked by the age limit'
        ),
      WAIT
    );
    expect(screen.queryByTestId('play-chips-downloaded')).toBeNull();
  });
});

describe('waiting for the server', () => {
  it('counts down to the next try when the record carries one', async () => {
    await resetWorld([
      {
        ...downloaded2160,
        state: 'waiting_server',
        completedAt: null,
        retryAt: Date.now() + 40_000,
      },
    ]);
    await open('/movie/123');
    expect(await screen.findByTestId('detail-download-line', {}, WAIT)).toHaveTextContent(
      /Waiting for the server · next try in (39|40) seconds/
    );
  });
});

describe('failure actions on the detail card (error.actions)', () => {
  it('only "Other version" when the release is gone: retrying it would fail again', async () => {
    await resetWorld([
      {
        ...downloaded2160,
        state: 'failed',
        completedAt: null,
        error: { code: 'download_source_gone', actions: ['otherVersion'], at: 0 },
      },
    ]);
    await open('/movie/123');
    await screen.findByTestId('detail-download', {}, WAIT);
    expect(screen.getByTestId('detail-download-other-version')).toBeOnTheScreen();
    expect(screen.queryByTestId('detail-download-retry')).toBeNull();
    expect(screen.queryByTestId('play-chips-downloaded')).toBeNull();
  });

  it('a missing local file (file_missing): reason, retry and delete; Play streams again', async () => {
    await resetWorld([
      {
        ...downloaded2160,
        state: 'failed',
        error: { code: 'file_missing', actions: ['retry', 'remove'], at: 0 },
      },
    ]);
    await open('/movie/123');
    const card = await screen.findByTestId('detail-download', {}, WAIT);
    expect(within(card).getByTestId('detail-download-reason')).toHaveTextContent(
      'The downloaded file is no longer on this device',
      { exact: false }
    );
    expect(screen.getByTestId('detail-download-retry')).toBeOnTheScreen();
    expect(screen.getByTestId('detail-download-remove')).toBeOnTheScreen();
    expect(screen.queryByTestId('detail-download-other-version')).toBeNull();
    expect(screen.queryByTestId('play-chips-downloaded')).toBeNull();
    const retry = jest.spyOn(world.downloads!.manager, 'retry');
    await userEvent.setup().press(screen.getByTestId('detail-download-retry'));
    expect(retry).toHaveBeenCalled();
  });
});

describe('series detail', () => {
  beforeEach(() =>
    resetWorld([
      { workId: 'tmdb-tv-7-s01e01', meta: { title: 'S1 Episode 1', seriesTitle: 'Sherlock' } },
      { workId: 'tmdb-tv-7-s01e02', meta: { title: 'S1 Episode 2', seriesTitle: 'Sherlock' } },
      {
        workId: 'tmdb-tv-7-s01e03',
        state: 'downloading',
        bytesWritten: GB / 4,
        completedAt: null,
        meta: { title: 'S1 Episode 3', seriesTitle: 'Sherlock' },
      },
    ])
  );

  it('large: the season chip counts the downloaded episodes, the cards carry their marks', async () => {
    await open('/series/7');
    expect(await screen.findByTestId('season-1', {}, WAIT)).toHaveTextContent(
      'Season 1 · 0/3 · 2/3 downloaded'
    );
    expect(await screen.findByTestId('episode-card-1-download-done', {}, WAIT)).toBeOnTheScreen();
    expect(screen.getByTestId('episode-card-3-download-active')).toBeOnTheScreen();
    expect(screen.getByTestId('play-chips-downloaded')).toHaveTextContent('Downloaded');
  });

  it('phone: rows show the state, the season heading offers the whole season', async () => {
    mockWindow = PHONE;
    const { router } = await open('/series/7');
    expect(await screen.findByTestId('season-1', {}, WAIT)).toHaveTextContent(/2\/3 downloaded/);
    expect(screen.getByTestId('episode-1-download')).toHaveProp(
      'accessibilityLabel',
      'Download: Downloaded'
    );
    expect(screen.getByTestId('series-download')).toHaveTextContent('Downloaded');
    await userEvent.setup().press(screen.getByTestId('series-season-download'));
    await waitFor(() => expect(router.getPathname()).toBe('/download/tmdb-tv-7-s01'));
    expect(router.getSearchParams()).toMatchObject({ series: 'Sherlock' });
  });
});
