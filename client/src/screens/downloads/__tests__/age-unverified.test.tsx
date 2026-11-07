import { userEvent, within } from '@testing-library/react-native';
import { screen, waitFor } from 'expo-router/testing-library';

import { clearWorld, open, resetWorld, version, WAIT, world } from '@/../jest/downloads-ui-world';
import { TEST_ACCOUNT_KEY } from '@/../jest/downloads';
import { ACCESS_VERDICT_MAX_AGE_MS } from '@/downloads/library';

const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

/** A profile with an age limit: an unknown or stale verdict locks (`lockOf` → `age_unverified`). */
const restrict = () =>
  world.downloads!.store.setPolicy(TEST_ACCOUNT_KEY, {
    maxAge: 12,
    blockUnrated: false,
    allowDownloads: true,
    at: Date.now(),
  });

const unverified = {
  workId: 'tmdb-movie-123',
  releaseId: 'r2',
  sourceReleaseId: 'r2',
  version: version(2, { recommended: false }) as never,
  meta: { title: 'Sintel', accessVerified: false } as never,
};

afterEach(() => clearWorld());

describe('a download whose age rating the server has not confirmed yet (C2-08)', () => {
  it('the list says the rating is being checked (unknown and stale verdicts) and offers only Remove', async () => {
    await resetWorld([
      unverified,
      {
        workId: 'tmdb-movie-789',
        meta: {
          title: 'Elephants Dream',
          minimumAge: 6,
          rated: true,
          accessVerified: true,
          accessCheckedAt: Date.now() - ACCESS_VERDICT_MAX_AGE_MS - 86_400_000,
        } as never,
      },
      {
        workId: 'tmdb-movie-456',
        meta: { title: 'Tears of Steel' },
        error: { code: 'age_restricted', at: 1 },
      },
    ]);
    restrict();
    await open('/downloads');
    for (const workId of ['tmdb-movie-123', 'tmdb-movie-789']) {
      const row = await screen.findByTestId(`download-${workId}`, {}, WAIT);
      expect(within(row).getByText('Checking the age rating…')).toBeOnTheScreen();
      expect(screen.queryByTestId(`download-${workId}-play`)).toBeNull();
      expect(screen.queryByTestId(`download-${workId}-open`)).toBeNull();
      expect(screen.getByTestId(`download-${workId}-delete`)).toBeOnTheScreen();
    }
    const known = screen.getByTestId('download-tmdb-movie-456');
    expect(within(known).getByText('Not cleared for this profile')).toBeOnTheScreen();
    expect(within(known).queryByText('Checking the age rating…')).toBeNull();
  });

  it('the detail entry and the sheet show it like a lock, with the checking text', async () => {
    await resetWorld([unverified]);
    restrict();
    await open('/movie/123');
    await waitFor(
      () =>
        expect(screen.getByTestId('movie-download')).toHaveProp(
          'accessibilityLabel',
          'Download: Checking the age rating…'
        ),
      WAIT
    );
    expect(screen.queryByTestId('play-chips-downloaded')).toBeNull();
    await userEvent.setup().press(screen.getByTestId('movie-download'));
    const already = await screen.findByTestId('download-already', {}, WAIT);
    expect(already).toHaveTextContent('Checking the age rating…', { exact: false });
    expect(already).toHaveTextContent('until you remove it in Downloads', { exact: false });
    expect(already).not.toHaveTextContent('Locked for your profile', { exact: false });
  });

  it('an unrestricted profile plays it: no verdict needed', async () => {
    await resetWorld([unverified]);
    await open('/downloads');
    expect(await screen.findByTestId('download-tmdb-movie-123-play', {}, WAIT)).toBeOnTheScreen();
    expect(screen.queryByText('Checking the age rating…')).toBeNull();
  });
});
