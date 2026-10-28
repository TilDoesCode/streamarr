import { fireEvent, within } from '@testing-library/react-native';
import { screen, waitFor } from 'expo-router/testing-library';

import { clearWorld, json, open, resetWorld, WAIT, world } from '../../../jest/mylist-world';
import type { ServiceStatus } from '../service-status';

// expo-router/testing-library installs its own Reanimated mock, which lacks useReducedMotion and makeMutable.
const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

const since = '2026-10-24T12:05:00Z';
const category = (id: string, state = 'ok', affected = 0, total = 2) => ({
  id,
  state,
  since: state === 'ok' ? null : since,
  affected,
  total,
});

const usenetDown = (adminNotified: boolean): ServiceStatus => ({
  state: 'down',
  categories: [
    category('search'),
    category('usenet', 'down', 2, 2),
    category('metadata', 'ok', 0, 1),
    category('server', 'ok', 0, 3),
  ],
  impacts: ['playbackUnavailable'],
  since,
  checkedAt: '2026-10-24T12:08:00Z',
  adminNotified,
});

const STATUS = '/api/v1/viewer/diagnostics/status';
const serve = (status: ServiceStatus) => (world.handlers[STATUS] = () => json(200, status));

beforeEach(resetWorld);
afterEach(clearWorld);

describe('diagnostics verdict during an outage', () => {
  it('an outage: since when, what does not work and what still does; Check again re-probes', async () => {
    serve(usenetDown(true));
    await open('/connection');
    const verdict = await screen.findByTestId('service-verdict', {}, WAIT);
    expect(within(verdict).getByTestId('service-verdict-title')).toHaveTextContent(
      /^Usenet provider outage · since /
    );
    expect(
      within(within(verdict).getByTestId('service-verdict-broken')).getByText(
        'Usenet provider (playback)'
      )
    ).toBeOnTheScreen();
    const working = within(verdict).getByTestId('service-verdict-working');
    expect(within(working).getByText('Release search (indexers)')).toBeOnTheScreen();
    expect(within(working).getByText('Server (database, storage)')).toBeOnTheScreen();
    expect(within(verdict).getByTestId('service-verdict-message')).toHaveTextContent(
      /The admin is notified automatically\.$/
    );
    // During a problem the verdict offers Check again; the streaming path card keeps its own.
    expect(within(verdict).queryByTestId('service-verdict-speed')).toBeNull();
    expect(screen.getByTestId('connection-path-all')).toHaveProp(
      'accessibilityLabel',
      'Measure everything'
    );
    fireEvent.press(within(verdict).getByTestId('service-verdict-check'));
    await waitFor(
      () =>
        expect(
          world.requests.filter((request) => request === 'GET /api/v1/viewer/diagnostics').length
        ).toBeGreaterThanOrEqual(2),
      WAIT
    );
  });

  // Last: it navigates.
});
