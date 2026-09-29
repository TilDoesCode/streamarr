import { QueryClient } from '@tanstack/react-query';
import { userEvent } from '@testing-library/react-native';
import { Stack } from 'expo-router';
import { act, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import type { ReactNode } from 'react';

import { AccountStore, type KeyValueStorage } from '@/accounts/account-store';
import { AccountsProvider } from '@/accounts/accounts-provider';
import { signInFlow } from '@/accounts/sign-in-flow';
import { createMemoryVault } from '@/accounts/types';
import AppLayout from '@/app/(app)/_layout';
import HomeRoute from '@/app/(app)/index';
import ProfilesRoute from '@/app/(onboarding)/profiles';
import ServerRoute from '@/app/(onboarding)/server';
import ChangePasswordRoute from '@/app/(onboarding)/sign-in/change-password';
import SignInRoute from '@/app/(onboarding)/sign-in/index';
import SecondFactorRoute from '@/app/(onboarding)/sign-in/second-factor';
import { ToastProvider } from '@/components/ui/toast';
import { setLanguagePreference } from '@/i18n';
import { DesignProvider } from '@/theme';

// expo-router/testing-library installs its own Reanimated mock, which lacks useReducedMotion and makeMutable.
const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

const OPTIONS = {
  serverName: 'Dev World',
  passwordLogin: true,
  emailCodeLogin: true,
  passwordReset: true,
  twoFactor: true,
  passwordMinLength: 8,
};

jest.mock('@/api/probe', () => ({
  ...jest.requireActual('@/api/probe'),
  probeServer: jest.fn(async (input: string) => {
    const { AppError: Err } = jest.requireActual('@/api/errors');
    if (input.includes('off.test')) throw new Err('module_disabled', { status: 404 });
    if (input.includes('down.test')) throw new Err('network_unreachable');
    return { baseUrl: 'http://dev.test', name: 'Dev World', options: OPTIONS, insecure: false };
  }),
}));

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function session(n: number) {
  const soon = new Date(Date.now() + 3_600_000).toISOString();
  return {
    sessionId: `s${n}`,
    tokenType: 'Bearer',
    accessToken: `sva_${n}`,
    accessExpiresAt: soon,
    refreshToken: `svr_${n}`,
    refreshExpiresAt: soon,
    cookieMode: false,
  };
}

const profile = (id: string, username: string, displayName: string) => ({
  id,
  username,
  displayName,
  mustChangePassword: false,
  permissions: {},
});

/** Viewer auth + discover of a fake Dev World. */
async function fakeServer(input: Request): Promise<Response> {
  const path = new URL(input.url).pathname;
  const body = input.method === 'POST' ? ((await input.json()) as Record<string, string>) : {};
  if (path === '/api/v1/viewer/auth/login') {
    if (body.password !== 'streamarr')
      return json(401, { error: { code: 'invalid_credentials', message: 'no' } });
    if (body.login === 'ben') return json(200, { status: 'mfa_required', mfaToken: 'svm_1' });
    return json(200, {
      status: 'authenticated',
      session: session(1),
      viewer: profile('v-anna', 'anna', 'Anna'),
    });
  }
  if (path === '/api/v1/viewer/auth/login/second-factor') {
    if (body.code !== '123456')
      return json(401, { error: { code: 'invalid_code', message: 'no' } });
    return json(200, {
      status: 'authenticated',
      session: session(2),
      viewer: profile('v-ben', 'ben', 'Ben'),
    });
  }
  if (path === '/api/v1/viewer/catalog/discover')
    return json(200, {
      rows: [
        {
          id: 'trending-movies',
          kind: 'trending',
          mediaType: 'movie',
          items: [{ workId: 'tmdb-movie-1', mediaType: 'movie', tmdbId: 1, title: 'Sintel' }],
        },
      ],
    });
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

let store: AccountStore;

function Providers({ children }: { children: ReactNode }) {
  return (
    <DesignProvider>
      <ToastProvider>
        <AccountsProvider store={store} queryClient={new QueryClient()} fetch={fakeServer}>
          {children}
        </AccountsProvider>
      </ToastProvider>
    </DesignProvider>
  );
}

function RootLayout() {
  return (
    <Providers>
      <Stack screenOptions={{ headerShown: false }} />
    </Providers>
  );
}

const routes = {
  _layout: RootLayout,
  '(app)/_layout': AppLayout,
  '(app)/index': HomeRoute,
  '(onboarding)/server': ServerRoute,
  '(onboarding)/profiles': ProfilesRoute,
  '(onboarding)/sign-in/index': SignInRoute,
  '(onboarding)/sign-in/second-factor': SecondFactorRoute,
  '(onboarding)/sign-in/change-password': ChangePasswordRoute,
};

beforeEach(async () => {
  store = new AccountStore({ storage: memoryStorage(), vault: createMemoryVault() });
  global.fetch = jest.fn(fakeServer) as unknown as typeof fetch;
  await act(async () => {
    await setLanguagePreference('en');
  });
});

it('connects, rejects a wrong password and signs in', async () => {
  const user = userEvent.setup();
  const router = renderRouter(routes, { initialUrl: '/' });
  await router;
  expect(router.getPathname()).toBe('/server');

  await user.press(screen.getByTestId('server-connect'));
  expect(screen.getByText('Enter the server address.')).toBeOnTheScreen();

  await user.type(screen.getByTestId('server-address'), 'off.test');
  await user.press(screen.getByTestId('server-connect'));
  expect(await screen.findByText('Viewing is turned off')).toBeOnTheScreen();

  await user.clear(screen.getByTestId('server-address'));
  await user.type(screen.getByTestId('server-address'), 'dev.test');
  await user.press(screen.getByTestId('server-connect'));
  await waitFor(() => expect(router.getPathname()).toBe('/sign-in'));
  expect(screen.getByText('to Dev World')).toBeOnTheScreen();

  await user.type(screen.getByTestId('sign-in-login'), 'anna');
  await user.type(screen.getByTestId('sign-in-password'), 'wrong');
  await user.press(screen.getByTestId('sign-in-submit'));
  expect(await screen.findByText('Wrong username or password')).toBeOnTheScreen();

  await user.clear(screen.getByTestId('sign-in-password'));
  await user.type(screen.getByTestId('sign-in-password'), 'streamarr');
  await user.press(screen.getByTestId('sign-in-submit'));
  expect(await screen.findByText('Hi, Anna')).toBeOnTheScreen();
  expect(router.getPathname()).toBe('/');
  expect(await screen.findByText('Trending movies')).toBeOnTheScreen();
  expect(store.active()).toMatchObject({ username: 'anna', signedIn: true });
});

it('validates and verifies the second factor', async () => {
  const user = userEvent.setup();
  const router = renderRouter(routes, { initialUrl: '/sign-in?server=http%3A%2F%2Fdev.test' });
  await router;
  await user.type(await screen.findByTestId('sign-in-login'), 'ben');
  await user.type(screen.getByTestId('sign-in-password'), 'streamarr');
  await user.press(screen.getByTestId('sign-in-submit'));
  await waitFor(() => expect(router.getPathname()).toBe('/sign-in/second-factor'));

  await user.type(screen.getByTestId('second-factor-code'), '12345');
  await user.press(screen.getByTestId('second-factor-submit'));
  expect(screen.getByText('Enter the 6 digits from your app.')).toBeOnTheScreen();

  await user.clear(screen.getByTestId('second-factor-code'));
  await user.type(screen.getByTestId('second-factor-code'), '000000');
  await user.press(screen.getByTestId('second-factor-submit'));
  expect(await screen.findByText('Wrong code')).toBeOnTheScreen();

  await user.clear(screen.getByTestId('second-factor-code'));
  await user.type(screen.getByTestId('second-factor-code'), '123456');
  await user.press(screen.getByTestId('second-factor-submit'));
  expect(await screen.findByText('Hi, Ben')).toBeOnTheScreen();
  expect(store.active()?.username).toBe('ben');
});

it('sends signed-out profiles to the picker', async () => {
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
  await store.signOut(anna.id, 'refresh_token_reused');
  const router = renderRouter(routes, { initialUrl: '/' });
  await router;
  expect(router.getPathname()).toBe('/profiles');
  expect(screen.getByText('Who’s watching?')).toBeOnTheScreen();
  expect(screen.getByText('Signed out for your security')).toBeOnTheScreen();
});

it('clears a password error while retyping; sign-out there forgets the kept password', async () => {
  const user = userEvent.setup();
  const mia = await store.addSignedIn(
    { url: 'http://dev.test', name: 'Dev World' },
    { id: 'v-mia', username: 'mia', displayName: 'Mia', mustChangePassword: true },
    {
      sessionId: 's1',
      accessToken: 'sva_1',
      accessExpiresAt: Date.now() + 3_600_000,
      refreshToken: 'svr_1',
      refreshExpiresAt: Date.now() + 3_600_000,
    }
  );
  store.setActive(mia.id);
  signInFlow.rememberPassword(mia.id, 'streamarr');
  const router = renderRouter(routes, { initialUrl: '/' });
  await router;
  await waitFor(() => expect(router.getPathname()).toBe('/sign-in/change-password'));

  await user.type(screen.getByTestId('new-password'), 'abc');
  await user.press(screen.getByTestId('change-submit'));
  expect(screen.getByText('Use at least 8 characters.')).toBeOnTheScreen();
  await user.type(screen.getByTestId('new-password'), 'd');
  expect(screen.queryByText('Use at least 8 characters.')).toBeNull();

  await user.press(screen.getByTestId('change-sign-out'));
  await waitFor(() => expect(router.getPathname()).toBe('/profiles'));
  expect(store.get(mia.id)).toMatchObject({ signedIn: false });
  expect(signInFlow.takePassword(mia.id)).toBeUndefined();
});
