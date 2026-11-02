import { QueryClient } from '@tanstack/react-query';
import { userEvent } from '@testing-library/react-native';
import { router as expoRouter, Stack } from 'expo-router';
import { act, renderRouter, screen, waitFor, within } from 'expo-router/testing-library';
import type { ReactNode } from 'react';

import { AccountStore, type KeyValueStorage } from '@/accounts/account-store';
import { AccountsProvider } from '@/accounts/accounts-provider';
import { createMemoryVault } from '@/accounts/types';
import { AppError } from '@/api/errors';
import { ToastProvider } from '@/components/ui/toast';
import { setLanguagePreference } from '@/i18n';
import { DesignProvider } from '@/theme';

import { appRoutes } from '../../../../jest/app-routes';
import { createFakeEmbeddedServer, RUNNING_ADDRESSES } from '../../../../jest/embedded-server-fake';

const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

const mockServer = createFakeEmbeddedServer();
jest.mock('@modules/embedded-server', () => ({
  get embeddedServer() {
    return mockServer;
  },
}));

const mockOptions = { serverName: 'Wohnzimmer', passwordLogin: true, passwordMinLength: 8 };
let mockViewer: 'ok' | 'module_disabled' = 'ok';
jest.mock('@/api/probe', () => ({
  ...jest.requireActual('@/api/probe'),
  probeServer: jest.fn(async (input: string) => {
    const { AppError: Err } = jest.requireActual('@/api/errors');
    if (mockViewer === 'module_disabled') throw new Err('module_disabled', { status: 404 });
    return { baseUrl: input, name: 'Wohnzimmer', options: mockOptions, insecure: false };
  }),
}));
jest.mock('@/api/http', () => ({
  ...jest.requireActual('@/api/http'),
  xhrTransport: jest.fn(async () => ({
    status: 200,
    body: '{"status":"ok","version":"0.21.0"}',
    contentType: 'application/json',
  })),
}));

function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getString: (key) => map.get(key),
    set: (key, value) => void map.set(key, value),
    remove: (key) => map.delete(key),
  };
}

let store: AccountStore;

function RootLayout() {
  return (
    <Providers>
      <Stack screenOptions={{ headerShown: false }} />
    </Providers>
  );
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <DesignProvider>
      <ToastProvider>
        <AccountsProvider
          store={store}
          queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
          fetch={async () => new Response(null, { status: 404 })}>
          {children}
        </AccountsProvider>
      </ToastProvider>
    </DesignProvider>
  );
}

const routes = { _layout: RootLayout, ...appRoutes };

beforeEach(async () => {
  mockServer.reset();
  mockViewer = 'ok';
  store = new AccountStore({ storage: memoryStorage(), vault: createMemoryVault() });
  await act(async () => {
    await setLanguagePreference('en');
  });
});

const open = async () => {
  const router = renderRouter(routes, { initialUrl: '/server/local' });
  await router;
  await screen.findByTestId('local-server-status');
  return { router };
};

const running = async () => {
  await act(async () => {
    mockServer.emit({
      state: 'running',
      startedAt: Date.now() - 120_000,
      version: '0.21.0+abc',
      addresses: RUNNING_ADDRESSES,
    });
  });
  await waitFor(() =>
    expect(screen.getByTestId('local-server-state')).toHaveTextContent('Running')
  );
};

it('offers the local server in onboarding and opens it', async () => {
  const user = userEvent.setup();
  const router = renderRouter(routes, { initialUrl: '/' });
  await router;
  expect(router.getPathname()).toBe('/server');
  expect(screen.getByText('Use this device as the server')).toBeOnTheScreen();
  await user.press(screen.getByTestId('server-use-local'));
  await waitFor(() => expect(router.getPathname()).toBe('/server/local'));
  expect(await screen.findByText('Server on this device')).toBeOnTheScreen();
});

it('hides the onboarding entry where the server is unsupported and explains a deep link', async () => {
  mockServer.supported = false;
  const router = renderRouter(routes, { initialUrl: '/' });
  await router;
  expect(router.getPathname()).toBe('/server');
  expect(screen.queryByTestId('server-use-local')).toBeNull();

  await act(async () => expoRouter.push('/server/local'));
  expect(await screen.findByTestId('local-server-unsupported')).toHaveTextContent(
    'The built-in server isn’t available on this device.'
  );
});

it('starts the server and shows its state, QR code and addresses', async () => {
  const user = userEvent.setup();
  await open();
  expect(screen.getByTestId('local-server-state')).toHaveTextContent('Stopped');
  expect(screen.getByTestId('local-server-qr-placeholder')).toBeOnTheScreen();
  expect(screen.getByTestId('local-server-check-running-todo')).toBeOnTheScreen();

  await user.press(screen.getByTestId('local-server-start'));
  expect(mockServer.calls).toContain('start');
  expect(await screen.findByText('Starting')).toBeOnTheScreen();
  expect(screen.getByTestId('local-server-check-running-checking')).toBeOnTheScreen();

  await running();
  expect(screen.getByTestId('local-server-state')).toHaveTextContent('Running');
  expect(screen.getByTestId('local-server-uptime')).toHaveTextContent('2 min');
  expect(screen.getByTestId('local-server-version')).toHaveTextContent('0.21.0');
  expect(screen.getByTestId('local-server-qr')).toBeOnTheScreen();
  expect(screen.getByTestId('local-server-qr-url')).toHaveTextContent('http://192.168.1.20:8080');
  const addresses = within(screen.getByTestId('local-server-addresses'));
  expect(addresses.getByText('LAN')).toBeOnTheScreen();
  expect(addresses.getByText('Tailscale')).toBeOnTheScreen();
  expect(addresses.getByText('Loopback')).toBeOnTheScreen();
  expect(screen.getByTestId('local-server-stop')).toBeOnTheScreen();
});

it('shows a failed start with its detail', async () => {
  await open();
  await act(async () => {
    mockServer.emit({ state: 'failed', lastError: 'Port 1: permission denied', restartCount: 2 });
  });
  await waitFor(() => expect(screen.getByTestId('local-server-state')).toHaveTextContent('Error'));
  expect(screen.getByTestId('local-server-failed')).toHaveTextContent(/Port 1: permission denied/);
  expect(screen.getByTestId('local-server-restarts')).toHaveTextContent('2 automatic restarts');
  expect(screen.getByTestId('local-server-check-running-failed')).toBeOnTheScreen();
  expect(screen.getByText('Start again')).toBeOnTheScreen();
});

it('walks the readiness checklist and connects over loopback', async () => {
  const user = userEvent.setup();
  const { router } = await open();
  await running();
  expect(await screen.findByTestId('local-server-check-ready-done')).toBeOnTheScreen();
  expect(screen.getByTestId('local-server-check-api-done')).toBeOnTheScreen();
  expect(screen.getByTestId('local-server-check-viewer-done')).toBeOnTheScreen();
  await user.press(screen.getByTestId('local-server-connect'));
  await waitFor(() => expect(router.getPathname()).toBe('/sign-in'));
  expect(router.getSearchParams()).toMatchObject({ server: 'http://127.0.0.1:8080' });
});

it('asks to turn on viewer accounts when the module is off', async () => {
  mockViewer = 'module_disabled';
  await open();
  await running();
  expect(await screen.findByTestId('local-server-check-viewer-failed')).toBeOnTheScreen();
  expect(
    screen.getByText(/Turn on viewer accounts in the web UI/, { exact: false })
  ).toBeOnTheScreen();
  expect(screen.queryByTestId('local-server-connect')).toBeNull();
});

it('reveals and hides the admin password, and says when it was changed', async () => {
  const user = userEvent.setup();
  await open();
  expect(await screen.findByTestId('local-server-username')).toHaveTextContent('admin');
  expect(screen.getByTestId('local-server-password')).not.toHaveTextContent('Secret-123');
  await user.press(screen.getByTestId('local-server-password-toggle'));
  expect(screen.getByTestId('local-server-password')).toHaveTextContent('Secret-123');
  await user.press(screen.getByTestId('local-server-password-toggle'));
  expect(screen.getByTestId('local-server-password')).not.toHaveTextContent('Secret-123');
});

it('reports a password changed in the web UI', async () => {
  mockServer.credentials = { username: 'admin', password: null };
  await open();
  expect(await screen.findByTestId('local-server-password')).toHaveTextContent(
    'Changed in the web UI'
  );
  expect(screen.getByTestId('local-server-password-changed')).toBeOnTheScreen();
  expect(screen.queryByTestId('local-server-password-toggle')).toBeNull();
});

it('resets the admin password only on the second press', async () => {
  const user = userEvent.setup();
  await open();
  await user.press(screen.getByTestId('local-server-reset-password'));
  expect(mockServer.calls).not.toContain('reset');
  expect(screen.getByText('Press again to reset')).toBeOnTheScreen();
  await user.press(screen.getByTestId('local-server-reset-password'));
  expect(await screen.findByTestId('local-server-reset-done')).toBeOnTheScreen();
  expect(mockServer.calls).toContain('reset');
  expect(screen.getByTestId('local-server-password')).toHaveTextContent('Fresh-456');
});

it('validates the port and applies it on the next start', async () => {
  const user = userEvent.setup();
  await open();
  const field = screen.getByTestId('local-server-port-input');
  await user.clear(field);
  await user.type(field, '80');
  await user.press(screen.getByTestId('local-server-port-apply'));
  expect(screen.getByText('Choose a port between 1024 and 65535.')).toBeOnTheScreen();
  expect(mockServer.calls).toEqual([]);

  await user.clear(field);
  await user.type(field, '9000');
  await user.press(screen.getByTestId('local-server-port-apply'));
  await waitFor(() => expect(mockServer.calls).toEqual(['port:9000']));

  await running();
  expect(await screen.findByTestId('local-server-port-pending')).toHaveTextContent(
    /Port 9000 is used from the next start/
  );
  expect(screen.getByTestId('local-server-port')).toHaveTextContent('8080');
});

it('switches autostart', async () => {
  const user = userEvent.setup();
  await open();
  await user.press(screen.getByTestId('local-server-autostart-off'));
  await waitFor(() => expect(mockServer.calls).toEqual(['autostart:false']));
});

it('shows the log', async () => {
  const user = userEvent.setup();
  mockServer.logs = ['starting Streamarr.Server on :8080', 'Now listening on: http://0.0.0.0:8080'];
  await open();
  await user.press(screen.getByTestId('local-server-logs-toggle'));
  expect(await screen.findByText(/Now listening on/)).toBeOnTheScreen();
  expect(screen.getByText('Log (last 200 lines)')).toBeOnTheScreen();
});

it('shows a native failure of an action as a localized error', async () => {
  const user = userEvent.setup();
  const start = jest
    .spyOn(mockServer, 'start')
    .mockRejectedValue(new AppError('local_server_failed', { detail: 'binder died' }));
  try {
    await open();
    await user.press(screen.getByTestId('local-server-start'));
    expect(
      await screen.findByTestId('local-server-action-error-local_server_failed')
    ).toBeOnTheScreen();
    expect(screen.getByText('The server didn’t respond')).toBeOnTheScreen();
  } finally {
    start.mockRestore();
  }
});
