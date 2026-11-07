import { userEvent, within } from '@testing-library/react-native';
import { router as navigate } from 'expo-router';
import { act, screen, waitFor } from 'expo-router/testing-library';

import {
  clearWorld,
  GB,
  json,
  open,
  resetWorld,
  startThroughCore,
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
    let finish = () => undefined as void;
    const pause = jest
      .spyOn(world.downloads!.manager, 'pause')
      .mockImplementation(() => new Promise<void>((done) => void (finish = done)));
    const button = screen.getByTestId('detail-download-pause');
    const user = userEvent.setup();
    await user.press(button);
    expect(pause).toHaveBeenCalledWith(download!.id);
    // The engine is slow to pause: the button waits, ignores a second press and stays the same (focused) control.
    expect(button).toHaveProp('accessibilityState', expect.objectContaining({ busy: true }));
    expect(button).toHaveProp('accessibilityLabel', 'Sintel: Pausing…');
    expect(button).toBeEnabled();
    await user.press(button);
    expect(pause).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(screen.getByTestId('detail-download-pause')).toBe(button);
    expect(button.props.accessibilityState?.busy).toBeFalsy();
    expect(button).toHaveProp('accessibilityLabel', 'Pause the download of Sintel');
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
          'Download: Locked for your profile'
        ),
      WAIT
    );
    expect(screen.queryByTestId('play-chips-downloaded')).toBeNull();
    // The sheet says it is locked (not "already on this device") and points to Downloads to remove it.
    await userEvent.setup().press(screen.getByTestId('movie-download'));
    const already = await screen.findByTestId('download-already', {}, WAIT);
    expect(already).toHaveTextContent('Locked for your profile', { exact: false });
    expect(already).toHaveTextContent('until you remove it in Downloads', { exact: false });
    expect(already).not.toHaveTextContent('Already on this device', { exact: false });
  });
});

describe('a download on storage that is not connected', () => {
  it('finished: the entry and the card say "Storage not available", Play streams, no retry', async () => {
    await resetWorld([
      {
        ...downloaded2160,
        volumeId: 'volume-1234',
        error: { code: 'volume_unavailable', at: 0 },
      },
    ]);
    await open('/movie/123');
    await waitFor(
      () =>
        expect(screen.getByTestId('movie-download')).toHaveProp(
          'accessibilityLabel',
          'Download: Storage not available'
        ),
      WAIT
    );
    const card = screen.getByTestId('detail-download');
    expect(within(card).getByText('Storage not available')).toBeOnTheScreen();
    expect(screen.getByTestId('detail-download-reason')).toHaveTextContent(
      'It’s back once the storage is connected again',
      { exact: false }
    );
    expect(screen.queryByTestId('detail-download-retry')).toBeNull();
    expect(screen.queryByTestId('play-chips-downloaded')).toBeNull();
  });

  it('waiting: says it continues by itself, shows its bytes once, no retry', async () => {
    await resetWorld([
      {
        ...downloaded2160,
        state: 'waiting_volume',
        completedAt: null,
        volumeId: 'volume-1234',
        sizeBytes: 8_000_000_000,
        bytesWritten: 3_000_000_000,
        error: { code: 'volume_unavailable', at: 0 },
      },
    ]);
    await open('/movie/123');
    const card = await screen.findByTestId('detail-download', {}, WAIT);
    expect(within(card).getAllByText('Storage not available')).toHaveLength(1);
    expect(screen.getByTestId('detail-download-line')).toHaveTextContent('3 GB of 8 GB');
    expect(screen.getByTestId('detail-download-reason')).toHaveTextContent(
      'It continues by itself once the storage is back',
      { exact: false }
    );
    expect(screen.queryByTestId('detail-download-retry')).toBeNull();
  });
});

describe('a download being removed (the engine ends the transfer first)', () => {
  const running = {
    ...downloaded2160,
    state: 'downloading' as const,
    completedAt: null,
    sizeBytes: 8_000_000_000,
    bytesWritten: 3_000_000_000,
  };

  it('the card greys out without controls, then says "Removing…"; the entry is disabled', async () => {
    await resetWorld([running]);
    await open('/movie/123');
    await screen.findByTestId('detail-download-pause', {}, WAIT);
    const store = world.downloads!.store;
    await act(async () => {
      store.update(store.all()[0]!.id, { state: 'removing' });
    });
    expect(screen.getByTestId('detail-download-removing')).toBeOnTheScreen();
    for (const control of ['pause', 'resume', 'retry', 'remove'])
      expect(screen.queryByTestId(`detail-download-${control}`)).toBeNull();
    expect(screen.getByTestId('movie-download')).toBeDisabled();
    await waitFor(
      () => expect(screen.getByTestId('detail-download-removing')).toHaveTextContent('Removing…'),
      WAIT
    );
    expect(screen.getByTestId('movie-download')).toHaveProp(
      'accessibilityLabel',
      'Download: Removing…'
    );
  });

  it('the sheet refuses a new download of it until it is gone', async () => {
    await resetWorld([{ ...running, state: 'removing' }]);
    await open('/download/tmdb-movie-123?title=Sintel');
    const already = await screen.findByTestId('download-already', {}, WAIT);
    expect(already).toHaveTextContent('Removing…', { exact: false });
    // The core's work_removing text, the one a start of this work answers.
    expect(already).toHaveTextContent('This download is still being removed', { exact: false });
    expect(screen.queryByTestId('download-candidate-0')).toBeNull();
    const store = world.downloads!.store;
    await act(async () => {
      store.delete(store.all()[0]!.id);
    });
    await waitFor(() => expect(screen.queryByTestId('download-already')).toBeNull(), WAIT);
  });
});

describe('end to end: downloading a work again while its old download is removed', () => {
  it('detail and sheet say "Removing…" and refuse it; both unblock by themselves once it is gone', async () => {
    await resetWorld();
    world.handlers['/api/v1/viewer/downloads/candidates'] = () =>
      json(200, {
        workId: 'tmdb-movie-123',
        mediaType: 'movie',
        candidates: [
          {
            version: version(1),
            offline: { playable: true, engine: 'native', reasons: [] },
            sizeBytes: GB,
            sizeExact: true,
            sizeSource: 'resolved',
            seasonPack: false,
            recommended: true,
          },
        ],
        streamOnlyCount: 0,
        checkedAt: '2026-11-07T00:00:00Z',
      });
    // Open first: renderRouter installs a new fake clock, and the core's cancel retry must be scheduled on it.
    await open('/movie/123');
    const id = await startThroughCore('tmdb-movie-123', { title: 'Sintel' });
    const { engine, manager, store } = world.downloads!;
    engine.controls.stallDrain(id);
    let removal: Promise<void> = Promise.resolve();
    await act(async () => {
      removal = manager.remove(id);
    });
    expect(store.get(id)?.state).toBe('removing');
    const button = await screen.findByTestId('movie-download', {}, WAIT);
    await waitFor(
      () => expect(button).toHaveProp('accessibilityLabel', 'Download: Removing…'),
      WAIT
    );
    expect(button).toBeDisabled();

    await act(async () =>
      navigate.push({
        pathname: '/download/[workId]',
        params: { workId: 'tmdb-movie-123', title: 'Sintel' },
      })
    );
    const already = await screen.findByTestId('download-already', {}, WAIT);
    expect(already).toHaveTextContent('Removing…', { exact: false });
    expect(already).toHaveTextContent('This download is still being removed', { exact: false });
    expect(screen.queryByTestId('download-candidate-0')).toBeNull();
    // A start that races the removal is refused by the core (work_removing).
    await expect(
      manager.start('http://dev.test#v-anna', [{ workId: 'tmdb-movie-123', releaseId: 'r1' }])
    ).rejects.toMatchObject({ code: 'work_removing' });

    // renderRouter runs fake timers: findBy advances them past the core's backed-off cancel retry.
    await act(async () => engine.controls.releaseDrain(id));
    expect(await screen.findByTestId('download-candidate-0', {}, WAIT)).toBeOnTheScreen();
    expect(screen.queryByTestId('download-already')).toBeNull();
    await removal;
    await act(async () => navigate.back());
    await waitFor(
      () =>
        expect(screen.getByTestId('movie-download')).toHaveProp('accessibilityLabel', 'Download'),
      WAIT
    );
    expect(screen.getByTestId('movie-download')).toBeEnabled();
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
    const line = await screen.findByTestId('detail-download-line', {}, WAIT);
    expect(line).toHaveTextContent(/Next try in (39|40) seconds/);
    expect(line).not.toHaveTextContent('Waiting for the server');
    expect(
      within(screen.getByTestId('detail-download')).getAllByText('Waiting for the server')
    ).toHaveLength(1);
  });

  it.each([
    ['paused', 'Paused', '3 GB of 8 GB'],
    ['queued', 'Queued', null],
  ] as const)(
    'a %s card names its state once: the line holds only bytes',
    async (state, title, bytes) => {
      await resetWorld([
        {
          ...downloaded2160,
          state,
          completedAt: null,
          sizeBytes: bytes ? 8_000_000_000 : null,
          estimatedBytes: null,
          bytesWritten: bytes ? 3_000_000_000 : 0,
        },
      ]);
      await open('/movie/123');
      const card = await screen.findByTestId('detail-download', {}, WAIT);
      expect(within(card).getAllByText(title)).toHaveLength(1);
      if (bytes) expect(screen.getByTestId('detail-download-line')).toHaveTextContent(bytes);
      else expect(screen.queryByTestId('detail-download-line')).toBeNull();
    }
  );
});

describe('waiting for a new sign-in (signed out, revoked file link)', () => {
  it('says it continues after signing in again: no countdown, no retry, no error tone', async () => {
    await resetWorld([
      {
        ...downloaded2160,
        state: 'waiting_server',
        completedAt: null,
        retryAt: Date.now() + 600_000,
        error: { code: 'signed_out', at: 0 },
      },
    ]);
    await open('/movie/123');
    expect(await screen.findByTestId('detail-download-line', {}, WAIT)).toHaveTextContent(
      'Continues after you sign in again'
    );
    expect(screen.queryByTestId('detail-download-retry')).toBeNull();
    expect(screen.queryByTestId('detail-download-reason')).toBeNull();
  });
});

describe('failure actions on the detail card (error.actions)', () => {
  it.each([
    [
      'downloads_not_allowed',
      'Downloads are turned off for your profile – this continues automatically once they’re allowed again',
      'Download: Downloads off',
    ],
    ['age_restricted', 'Locked for your profile (age rating)', 'Download: Locked for your profile'],
  ])(
    '%s on a running download: on hold, a reason that it continues, its progress and only cancel',
    async (code, reason, entry) => {
      await resetWorld([
        {
          ...downloaded2160,
          state: 'failed',
          completedAt: null,
          sizeBytes: 8_000_000_000,
          bytesWritten: 3_000_000_000,
          error: { code, actions: ['remove'], status: 403, at: 0 },
        },
      ]);
      await open('/movie/123');
      const card = await screen.findByTestId('detail-download', {}, WAIT);
      expect(within(card).getByText('On hold')).toBeOnTheScreen();
      expect(within(card).queryByText('Failed')).toBeNull();
      expect(screen.getByTestId('detail-download-reason')).toHaveTextContent(reason);
      expect(screen.getByTestId('detail-download-line')).toHaveTextContent('3 GB of 8 GB');
      expect(screen.getByTestId('detail-download-bar')).toBeOnTheScreen();
      expect(screen.getByTestId('movie-download')).toHaveProp('accessibilityLabel', entry);
      expect(screen.getByTestId('detail-download-remove')).toBeOnTheScreen();
      expect(screen.queryByTestId('detail-download-retry')).toBeNull();
      expect(screen.queryByTestId('detail-download-other-version')).toBeNull();
    }
  );

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
