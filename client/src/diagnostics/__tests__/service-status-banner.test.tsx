import { fireEvent, screen } from '@testing-library/react-native';

import { AppError } from '@/api/errors';

import { renderWithProviders } from '../../../jest/render';
import { ServiceStatusBanner, SettingsTabDot } from '../service-status-ui';

const mockQuery: { data?: unknown; error: unknown; isError: boolean; isPending: boolean } = {
  error: null,
  isError: false,
  isPending: false,
};
const mockPush = jest.fn();
jest.mock('../service-status', () => ({
  ...jest.requireActual('../service-status'),
  useServiceStatus: () => mockQuery,
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

const outage = {
  state: 'degraded',
  categories: [
    { id: 'search', state: 'degraded', since: '2026-10-24T10:00:00Z', affected: 1, total: 3 },
    { id: 'usenet', state: 'ok', affected: 0, total: 2 },
    { id: 'metadata', state: 'ok', affected: 0, total: 1 },
    { id: 'server', state: 'ok', affected: 0, total: 3 },
  ],
  impacts: ['searchMayBeIncomplete'],
  since: '2026-10-24T10:00:00Z',
  checkedAt: '2026-10-24T10:06:00Z',
  adminNotified: true,
};

beforeEach(() => {
  Object.assign(mockQuery, { data: undefined, error: null, isError: false, isPending: false });
  mockPush.mockClear();
});

describe('ServiceStatusBanner', () => {
  it('a degraded search: impact, not your device, admin notified; opens the diagnostics', async () => {
    mockQuery.data = outage;
    await renderWithProviders(<ServiceStatusBanner />);
    expect(screen.getByTestId('service-status-banner-title')).toHaveTextContent(
      /^Problems with the release search · since /
    );
    expect(screen.getByTestId('service-status-banner-message')).toHaveTextContent(
      'Some versions may be missing right now. It’s the server, not your device. The admin is notified automatically.'
    );
    fireEvent.press(screen.getByTestId('service-status-banner'));
    expect(mockPush).toHaveBeenCalledWith('/connection');
  });

  it('an unreachable server says so instead of an outage, unless the screen already does', async () => {
    Object.assign(mockQuery, { isError: true, error: new AppError('network_unreachable') });
    const view = await renderWithProviders(<ServiceStatusBanner />);
    expect(screen.getByTestId('service-status-banner')).toHaveAccessibleName(
      /^Can’t reach the server\. Check this device’s internet connection/
    );
    await view.rerender(<ServiceStatusBanner hideUnreachable />);
    expect(screen.queryByTestId('service-status-banner')).toBeNull();
    await view.rerender(<SettingsTabDot size={10} />);
    expect(screen.queryByTestId('settings-status-dot')).toBeNull();
  });

  it('nothing while the status is ok or unknown', async () => {
    const view = await renderWithProviders(<ServiceStatusBanner />);
    expect(screen.queryByTestId('service-status-banner')).toBeNull();
    mockQuery.data = { ...outage, state: 'ok', categories: [], impacts: [], since: null };
    await view.rerender(<ServiceStatusBanner />);
    expect(screen.queryByTestId('service-status-banner')).toBeNull();
  });
});
