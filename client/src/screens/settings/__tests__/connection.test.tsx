import { QueryClient } from '@tanstack/react-query';
import { userEvent, within } from '@testing-library/react-native';
import { Stack } from 'expo-router';
import { act, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import type { ReactNode } from 'react';

import { AccountStore, type KeyValueStorage } from '@/accounts/account-store';
import { AccountsProvider } from '@/accounts/accounts-provider';
import { createMemoryVault } from '@/accounts/types';
import { ToastProvider } from '@/components/ui/toast';
import * as speedTest from '@/diagnostics/speed-test';
import { setLanguagePreference } from '@/i18n';
import { DesignProvider } from '@/theme';

import { appRoutes } from '../../../../jest/app-routes';

const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

type Handler = (url: URL, request: Request) => Response | Promise<Response>;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const WAIT = { timeout: 5000 };

const degraded = {
  status: 'degraded',
  hints: ['provider_auth_failed', 'some_providers_down', 'tmdb_slow'],
  server: { version: '0.18.0+abc', uptimeSeconds: 7_260, now: '2026-10-23T10:00:00Z' },
  components: [
    { id: 'database', kind: 'database', name: 'Database', status: 'ok', latencyMs: 1.4 },
    {
      id: 'metadata',
      kind: 'metadata',
      name: 'TMDB',
      status: 'degraded',
      latencyMs: 2_400,
      errorCode: 'slow',
    },
    {
      id: 'provider:1',
      kind: 'provider',
      name: 'Provider 1',
      status: 'ok',
      latencyMs: 143,
      connectionsInUse: 2,
      connectionsMax: 20,
    },
    {
      id: 'provider:2',
      kind: 'provider',
      name: 'Provider 2',
      status: 'down',
      latencyMs: 61,
      errorCode: 'auth_failed',
    },
    { id: 'indexer:1', kind: 'indexer', name: 'Indexer 1', status: 'ok', latencyMs: 412 },
    { id: 'disk', kind: 'disk', name: 'Storage', status: 'ok' },
    {
      id: 'streams',
      kind: 'streams',
      name: 'Streams',
      status: 'ok',
      activeStreams: 1,
      connectionsInUse: 4,
      connectionsMax: 20,
    },
  ],
  checkedAt: '2026-10-23T09:59:52Z',
  ageSeconds: 8,
  refreshAvailableAt: '2026-10-23T10:00:02Z',
};

let handlers: Record<string, Handler> = {};
let requests: URL[] = [];
let store: AccountStore;

async function fakeServer(input: Request): Promise<Response> {
  const url = new URL(input.url);
  requests.push(url);
  const handler = handlers[url.pathname];
  if (handler) return handler(url, input);
  return json(404, { error: { code: 'not_found', message: 'nope' } });
}

function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getString: (key) => map.get(key),
    set: (key, value) => void map.set(key, value),
    remove: (key) => map.delete(key),
  };
}

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
          fetch={fakeServer}>
          {children}
        </AccountsProvider>
      </ToastProvider>
    </DesignProvider>
  );
}

async function openConnection() {
  const anna = await store.addSignedIn(
    { url: 'http://dev.test', name: 'Dev World' },
    { id: 'v-anna', username: 'anna', displayName: 'Anna', mustChangePassword: false },
    {
      sessionId: 's1',
      accessToken: 'sva_1',
      accessExpiresAt: Date.now() + 3_600_000,
      refreshToken: 'svr_1',
      refreshExpiresAt: Date.now() + 3_600_000,
    }
  );
  store.setActive(anna.id);
  await renderRouter({ _layout: RootLayout, ...appRoutes }, { initialUrl: '/settings' });
  const user = userEvent.setup();
  await user.press(await screen.findByTestId('settings-connection', {}, WAIT));
  await screen.findByTestId('connection-screen', {}, WAIT);
  return user;
}

beforeEach(async () => {
  store = new AccountStore({ storage: memoryStorage(), vault: createMemoryVault() });
  requests = [];
  handlers = {
    '/api/v1/viewer/watch/resume': () => json(200, []),
    '/api/v1/viewer/watch/next-up': () => json(200, { items: [] }),
    '/api/v1/health': () => json(200, { version: '1.0.0' }),
    '/api/v1/viewer/me': () => json(200, { id: 'v-anna', username: 'anna', permissions: {} }),
    '/api/v1/viewer/me/sessions': () => json(200, []),
    '/api/v1/viewer/diagnostics': () => json(200, degraded),
    '/api/v1/viewer/diagnostics/ping': () =>
      json(200, {
        serverTime: '2026-10-23T10:00:00Z',
        maxDownloadBytes: 209_715_200,
        maxUploadBytes: 104_857_600,
        maxParallelTransfers: 6,
      }),
  };
  global.fetch = jest.fn(fakeServer) as unknown as typeof fetch;
  await act(async () => {
    await setLanguagePreference('en');
  });
});

afterEach(() => jest.restoreAllMocks());

describe('Connection & diagnostics (settings)', () => {
  it('shows the server verdict, every hint and each component with its status and latency', async () => {
    await openConnection();
    const status = await screen.findByTestId('connection-server-status', {}, WAIT);
    expect(within(status).getByText('Partly working')).toBeOnTheScreen();
    expect(
      within(status).getByText(/A Usenet provider rejects the server's login/)
    ).toBeOnTheScreen();
    const hints = screen.getByTestId('connection-server-hints');
    expect(within(hints).getByText(/One Usenet provider does not answer/)).toBeOnTheScreen();
    expect(within(hints).getByText(/TMDB\) answers slowly/)).toBeOnTheScreen();

    const bad = screen.getByTestId('connection-component-provider:2');
    expect(within(bad).getByText('Usenet provider 2')).toBeOnTheScreen();
    expect(screen.getByTestId('connection-component-provider:2-detail')).toHaveTextContent(
      'Login rejected · 61 ms'
    );
    expect(screen.getByTestId('connection-component-provider:1-detail')).toHaveTextContent(
      'OK · 2 of 20 connections · 143 ms'
    );
    expect(screen.getByTestId('connection-component-database-detail')).toHaveTextContent(
      'OK · 1.4 ms'
    );
    expect(screen.getByTestId('connection-component-streams-detail')).toHaveTextContent(
      'OK · 1 active stream · 4 of 20 connections'
    );
    expect(screen.getByTestId('connection-server-footer')).toHaveTextContent(
      'Server 0.18.0 · running for 2 h 1 min · checked 8 seconds ago'
    );
  });

  it('asks the server for fresh probes on "Check again"', async () => {
    const user = await openConnection();
    await screen.findByTestId('connection-server-status', {}, WAIT);
    handlers['/api/v1/viewer/diagnostics'] = () =>
      json(200, { ...degraded, status: 'ok', hints: [], ageSeconds: 0 });

    await user.press(screen.getByTestId('connection-server-refresh'));

    expect(await screen.findByText('Everything is working', {}, WAIT)).toBeOnTheScreen();
    expect(
      requests.some(
        (url) =>
          url.pathname === '/api/v1/viewer/diagnostics' &&
          url.searchParams.get('refresh') === 'true'
      )
    ).toBe(true);
    expect(screen.queryByTestId('connection-server-hints')).toBeNull();
  });

  it('explains when the server has no diagnostics', async () => {
    handlers['/api/v1/viewer/diagnostics'] = () =>
      json(503, { error: { code: 'server_error', message: 'boom' } });
    await openConnection();
    expect(await screen.findByTestId('connection-server-error', {}, WAIT)).toHaveTextContent(
      /The server diagnostics are not available/
    );
  });

  it('runs the speed test and judges the line by typical bitrates', async () => {
    const run = jest.spyOn(speedTest, 'runSpeedTest').mockImplementation(async ({ onProgress }) => {
      onProgress?.({ phase: 'download', fraction: 0.4, liveMbps: 30, pingMs: 12, jitterMs: 2 });
      return { pingMs: 12, jitterMs: 2, downloadMbps: 18.4, uploadMbps: 9.6 };
    });
    const user = await openConnection();

    await user.press(screen.getByTestId('connection-speed-start'));

    const verdict = await screen.findByTestId('connection-speed-verdict', {}, WAIT);
    expect(within(verdict).getByText('Good for 1080p')).toBeOnTheScreen();
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        limits: {
          maxDownloadBytes: 209_715_200,
          maxUploadBytes: 104_857_600,
          maxParallelTransfers: 6,
        },
      })
    );
    expect(screen.getByTestId('connection-speed-download')).toHaveTextContent('18 Mbit/s');
    expect(screen.getByTestId('connection-speed-upload')).toHaveTextContent('9.6 Mbit/s');
    expect(screen.getByTestId('connection-speed-ping')).toHaveTextContent('12 ms');
    expect(screen.getByTestId('connection-tier-fhd')).toHaveProp(
      'aria-label',
      '1080p: fast enough'
    );
    expect(screen.getByTestId('connection-tier-uhd')).toHaveProp(
      'aria-label',
      '4K HDR streaming version: too slow'
    );
    expect(screen.queryByTestId('connection-speed-latency')).toBeNull();
    expect(screen.getByText('Test again')).toBeOnTheScreen();
  });

  it('warns about slow round trips and reports a failed test', async () => {
    jest
      .spyOn(speedTest, 'runSpeedTest')
      .mockResolvedValueOnce({ pingMs: 180, jitterMs: 40, downloadMbps: 120, uploadMbps: 20 });
    const user = await openConnection();
    await user.press(screen.getByTestId('connection-speed-start'));
    expect(
      await screen.findByText('Good for 4K HDR, even full-quality remuxes', {}, WAIT)
    ).toBeOnTheScreen();
    expect(screen.getByTestId('connection-speed-latency')).toHaveTextContent(
      /Ping 180 ms, jitter 40 ms/
    );

    handlers['/api/v1/viewer/diagnostics/ping'] = () => json(500, {});
    await user.press(screen.getByTestId('connection-speed-start'));
    await waitFor(() => expect(screen.getByTestId('connection-speed-error')).toBeOnTheScreen());
    expect(screen.queryByTestId('connection-speed-verdict')).toBeNull();
  });
});
