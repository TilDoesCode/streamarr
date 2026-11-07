import { userEvent, within } from '@testing-library/react-native';
import { screen, waitFor } from 'expo-router/testing-library';

import { clearWorld, open, resetWorld, version, WAIT } from '@/../jest/downloads-ui-world';
import type { OfflineDownload, ViewerPolicy } from '@/downloads/types';

// Until DL-C1 ships the `age_unverified` lock (C2-08), a hand-built record carries it as its error code.
jest.mock('@/downloads/library', () => {
  const actual = jest.requireActual<typeof import('@/downloads/library')>('@/downloads/library');
  return {
    ...actual,
    lockOf: (download: OfflineDownload, policy: ViewerPolicy | null) =>
      (download.error?.code as string | undefined) === 'age_unverified'
        ? 'age_unverified'
        : actual.lockOf(download, policy),
  };
});

const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

const unverified = {
  workId: 'tmdb-movie-123',
  releaseId: 'r2',
  sourceReleaseId: 'r2',
  version: version(2, { recommended: false }) as never,
  meta: { title: 'Sintel' },
  error: { code: 'age_unverified', at: 1 } as never,
};

afterEach(() => clearWorld());

describe('a download whose age rating the server has not confirmed yet (C2-08)', () => {
  it('the list says the rating is being checked and offers only Remove', async () => {
    await resetWorld([
      unverified,
      {
        workId: 'tmdb-movie-456',
        meta: { title: 'Tears of Steel' },
        error: { code: 'age_restricted', at: 1 },
      },
    ]);
    await open('/downloads');
    const row = await screen.findByTestId('download-tmdb-movie-123', {}, WAIT);
    expect(within(row).getByText('Checking the age rating…')).toBeOnTheScreen();
    expect(screen.queryByTestId('download-tmdb-movie-123-play')).toBeNull();
    expect(screen.queryByTestId('download-tmdb-movie-123-open')).toBeNull();
    expect(screen.getByTestId('download-tmdb-movie-123-delete')).toBeOnTheScreen();
    const known = screen.getByTestId('download-tmdb-movie-456');
    expect(within(known).getByText('Not cleared for this profile')).toBeOnTheScreen();
    expect(within(known).queryByText('Checking the age rating…')).toBeNull();
  });

  it('the detail entry and the sheet show it like a lock, with the checking text', async () => {
    await resetWorld([unverified]);
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
});
