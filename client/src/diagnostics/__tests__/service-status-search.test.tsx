import { fireEvent, userEvent, within } from '@testing-library/react-native';
import { screen } from 'expo-router/testing-library';

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

const STATUS = '/api/v1/viewer/diagnostics/status';
const serve = (status: ServiceStatus) => (world.handlers[STATUS] = () => json(200, status));

beforeEach(resetWorld);
afterEach(clearWorld);

describe('search failure', () => {
  it('a failed search offers the server status', async () => {
    serve(ok);
    world.handlers['/api/v1/viewer/catalog/search'] = () =>
      json(404, { error: { code: 'not_found', message: 'x' } });
    await open('/search');
    const field = await screen.findByTestId('search-field', {}, WAIT);
    await userEvent.setup().type(field, 'sintel');
    const error = await screen.findByTestId('search-error', {}, WAIT);
    fireEvent.press(within(error).getByText('Show server status'));
    expect(await screen.findByTestId('connection-screen', {}, WAIT)).toBeOnTheScreen();
  });
});
