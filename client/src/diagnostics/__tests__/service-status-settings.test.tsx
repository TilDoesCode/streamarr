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

const ok: ServiceStatus = {
  state: 'ok',
  categories: [
    category('search'),
    category('usenet'),
    category('metadata', 'ok', 0, 1),
    category('server', 'ok', 0, 3),
  ],
  impacts: [],
  since: null,
  checkedAt: '2026-10-24T12:08:00Z',
  adminNotified: false,
};

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

describe('Settings and the diagnostics screen', () => {
  it('Settings starts with the server status', async () => {
    serve(usenetDown(false));
    await open('/settings');
    const entry = await screen.findByTestId('settings-status', {}, WAIT);
    await waitFor(
      () =>
        expect(within(entry).getByTestId('settings-status-title')).toHaveTextContent(
          'Usenet provider outage'
        ),
      WAIT
    );
    const sections = within(screen.getByTestId('settings-screen')).getAllByText(
      /^(Server status|Account)$/
    );
    expect(sections.map((node) => node.props.children)).toEqual(['Server status', 'Account']);
  });
  // Last: the speed test it starts keeps running.
  it('all fine: the verdict points at the connection and starts the speed test', async () => {
    serve(ok);
    world.handlers['/api/v1/viewer/diagnostics/ping'] = () =>
      json(200, {
        serverTime: '2026-10-24T12:08:00Z',
        maxDownloadBytes: 1,
        maxUploadBytes: 1,
        maxParallelTransfers: 1,
      });
    await open('/connection');
    const verdict = await screen.findByTestId('service-verdict', {}, WAIT);
    expect(within(verdict).getByTestId('service-verdict-title')).toHaveTextContent(
      'Everything is working'
    );
    expect(within(verdict).getByTestId('service-verdict-message')).toHaveTextContent(
      /most likely your connection/
    );
    expect(within(verdict).getByTestId('service-verdict-checked')).toHaveTextContent(
      /^Last checked /
    );
    fireEvent.press(within(verdict).getByTestId('service-verdict-speed'));
    await waitFor(
      () => expect(world.requests).toContain('GET /api/v1/viewer/diagnostics/ping'),
      WAIT
    );
  });
});
