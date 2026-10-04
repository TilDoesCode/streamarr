import { QueryClient } from '@tanstack/react-query';
import { userEvent, within } from '@testing-library/react-native';
import { Stack } from 'expo-router';
import { act, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import type { ReactNode } from 'react';

import { AccountStore, type KeyValueStorage } from '@/accounts/account-store';
import { AccountsProvider } from '@/accounts/accounts-provider';
import { createMemoryVault } from '@/accounts/types';
import { ToastProvider } from '@/components/ui/toast';
import { setLanguagePreference } from '@/i18n';
import { DesignProvider } from '@/theme';

import { appRoutes } from '../../../../jest/app-routes';
import { isBlankName } from '../profile-editor';

// expo-router/testing-library installs its own Reanimated mock, which lacks useReducedMotion and makeMutable.
const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

// Records the variant each Button renders with, by testID.
const mockVariants = new Map<string, string>();
jest.mock('@/components/ui/button', () => {
  const actual = jest.requireActual('@/components/ui/button');
  const { createElement } = jest.requireActual('react');
  return {
    ...actual,
    Button: (props: { testID?: string; variant?: string }) => {
      if (props.testID) mockVariants.set(props.testID, props.variant ?? 'primary');
      return createElement(actual.Button, props);
    },
  };
});

type Handler = (url: URL, request: Request) => Response | Promise<Response>;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const WAIT = { timeout: 5000 };

const profile = {
  id: 'v-anna',
  username: 'anna',
  displayName: 'Anna',
  email: 'anna@example.test',
  emailVerified: true,
  twoFactorEnabled: false,
  recoveryCodesRemaining: 0,
  permissions: {},
};
const sessions = [
  {
    id: 's1',
    deviceName: 'Chrome (Web)',
    clientName: 'Streamarr Web',
    authMethod: 'password',
    lastSeenAt: '2026-10-01T01:00:00Z',
    current: true,
  },
  {
    id: 's2',
    deviceName: 'google sdk_google_atv64_amati_arm64 (Android TV)',
    clientName: 'Streamarr Android TV',
    authMethod: 'password',
    lastSeenAt: '2026-09-30T20:00:00Z',
    current: false,
  },
  {
    id: 's3',
    deviceName: null,
    clientName: 'curl',
    authMethod: 'password',
    lastSeenAt: '2026-09-29T20:00:00Z',
    current: false,
  },
];

let handlers: Record<string, Handler> = {};
let store: AccountStore;

async function fakeServer(input: Request): Promise<Response> {
  const url = new URL(input.url);
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

async function openSettings() {
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
  const router = renderRouter({ _layout: RootLayout, ...appRoutes }, { initialUrl: '/settings' });
  await router;
}

beforeEach(async () => {
  store = new AccountStore({ storage: memoryStorage(), vault: createMemoryVault() });
  handlers = {
    '/api/v1/viewer/watch/resume': () => json(200, []),
    '/api/v1/viewer/watch/next-up': () => json(200, { items: [] }),
    '/api/v1/health': () => json(200, { version: '1.0.0' }),
    '/api/v1/viewer/me': () => json(200, profile),
    '/api/v1/viewer/me/sessions': () => json(200, sessions),
  };
  global.fetch = jest.fn(fakeServer) as unknown as typeof fetch;
  await act(async () => {
    await setLanguagePreference('en');
  });
});

describe('Settings account buttons (Q1-19)', () => {
  it('gives Sign out the same filled style as Switch and Edit profile, also Cancel in the editor', async () => {
    await openSettings();
    await screen.findByTestId('settings-sign-out');
    expect(mockVariants.get('settings-switch-profile')).toBe('secondary');
    expect(mockVariants.get('settings-edit-profile')).toBe('secondary');
    expect(mockVariants.get('settings-sign-out')).toBe('secondary');
    await userEvent.setup().press(screen.getByTestId('settings-edit-profile'));
    expect(mockVariants.get('settings-profile-cancel')).toBe('secondary');
  });
});

describe('Profile editor display name', () => {
  it('treats only spaces as blank, but not the empty reset', () => {
    expect(isBlankName('   ')).toBe(true);
    expect(isBlankName('')).toBe(false);
    expect(isBlankName(' Bo ')).toBe(false);
  });

  it('blocks a name of only spaces and saves a trimmed name', async () => {
    const bodies: unknown[] = [];
    handlers['/api/v1/viewer/me'] = async (_url, request) => {
      if (request.method === 'PATCH') {
        const body = (await request.json()) as { displayName: string | null };
        bodies.push(body);
        return json(200, { ...profile, displayName: body.displayName ?? 'anna' });
      }
      return json(200, profile);
    };
    const user = userEvent.setup();
    await openSettings();
    await user.press(await screen.findByTestId('settings-edit-profile'));
    await user.clear(screen.getByTestId('settings-profile-name'));
    await user.type(screen.getByTestId('settings-profile-name'), '   ');
    expect(screen.getByText(/can’t be only spaces/)).toBeOnTheScreen();
    expect(screen.getByTestId('settings-profile-save')).toBeDisabled();
    await user.press(screen.getByTestId('settings-profile-save'));
    expect(bodies).toEqual([]);

    await user.type(screen.getByTestId('settings-profile-name'), 'Bo ');
    expect(screen.queryByText(/can’t be only spaces/)).toBeNull();
    await user.press(screen.getByTestId('settings-profile-save'));
    await waitFor(() => expect(bodies).toHaveLength(1), WAIT);
    expect(bodies[0]).toMatchObject({ displayName: 'Bo' });
  });
});

describe('Settings devices (Q1-20, Q1-23)', () => {
  it('shows friendly and translated fallback device names', async () => {
    await openSettings();
    expect(await screen.findByText('Emulator (Android TV)')).toBeOnTheScreen();
    expect(screen.getByText('Unknown device')).toBeOnTheScreen();
    await act(async () => {
      await setLanguagePreference('de');
    });
    expect(await screen.findByText('Unbekanntes Gerät')).toBeOnTheScreen();
  });

  it('asks before signing out every other device', async () => {
    const posts: string[] = [];
    handlers['/api/v1/viewer/me/sessions/sign-out-others'] = (_url, request) => {
      posts.push(request.method);
      return json(200, { signedOut: 2 });
    };
    const user = userEvent.setup();
    await openSettings();
    await user.press(await screen.findByTestId('settings-devices-sign-out-others'));
    expect(screen.getByTestId('sign-out-others-dialog')).toBeOnTheScreen();
    expect(screen.getByText('Sign out all 2 other devices?')).toBeOnTheScreen();
    expect(posts).toEqual([]);

    await user.press(
      within(screen.getByTestId('sign-out-others-dialog')).getByRole('button', { name: 'Cancel' })
    );
    expect(posts).toEqual([]);

    await user.press(screen.getByTestId('settings-devices-sign-out-others'));
    await user.press(
      within(screen.getByTestId('sign-out-others-dialog')).getByRole('button', {
        name: 'Sign out',
      })
    );
    await waitFor(() => expect(posts).toEqual(['POST']), WAIT);
  });
});
