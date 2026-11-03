import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, screen, userEvent, waitFor } from '@testing-library/react-native';

import { setLanguagePreference } from '@/i18n';

import { renderWithProviders } from '../../../jest/render';
import { createFakeEmbeddedServer, RUNNING_ADDRESSES } from '../../../jest/embedded-server-fake';
import { LocalServerSection } from '../settings-entry';

const mockServer = createFakeEmbeddedServer();
jest.mock('@modules/embedded-server', () => ({
  get embeddedServer() {
    return mockServer;
  },
}));
const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

const render = () =>
  renderWithProviders(
    <QueryClientProvider client={new QueryClient()}>
      <LocalServerSection />
    </QueryClientProvider>
  );

beforeEach(async () => {
  mockServer.reset();
  mockPush.mockClear();
  await act(async () => {
    await setLanguagePreference('en');
  });
});

it('is hidden where the server is unsupported', async () => {
  mockServer.supported = false;
  await render();
  expect(screen.queryByTestId('settings-local-server')).toBeNull();
});

it('shows the live state and opens the local-server screen', async () => {
  const user = userEvent.setup();
  await render();
  expect(await screen.findByTestId('settings-local-server-state')).toHaveTextContent('Stopped');
  await act(async () => {
    mockServer.emit({ state: 'running', addresses: RUNNING_ADDRESSES });
  });
  await waitFor(() =>
    expect(screen.getByTestId('settings-local-server-state')).toHaveTextContent('Running')
  );
  expect(screen.getByText('Reachable at http://192.168.1.20:8080')).toBeOnTheScreen();
  await user.press(screen.getByTestId('settings-local-server-open'));
  expect(mockPush).toHaveBeenCalledWith('/server/local');
});
