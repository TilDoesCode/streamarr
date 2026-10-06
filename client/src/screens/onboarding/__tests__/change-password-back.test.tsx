import { QueryClient } from '@tanstack/react-query';
import { router as navigate, Stack } from 'expo-router';
import { act, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import type { ReactNode } from 'react';
import { BackHandler, Platform, View } from 'react-native';

import { AccountStore, type KeyValueStorage } from '@/accounts/account-store';
import { AccountsProvider } from '@/accounts/accounts-provider';
import { holdForPlayer } from '@/accounts/player-hold';
import { createMemoryVault } from '@/accounts/types';
import AppLayout from '@/app/(app)/_layout';
import ProfilesRoute from '@/app/(onboarding)/profiles';
import ChangePasswordRoute from '@/app/(onboarding)/sign-in/change-password';
import { currentMenuMode } from '@/components/focus';
import { ToastProvider } from '@/components/ui/toast';
import { setLanguagePreference } from '@/i18n';
import { DesignProvider } from '@/theme';

// expo-router/testing-library installs its own Reanimated mock, which lacks useReducedMotion and makeMutable.
const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

// RN's Jest mock of the native View lacks Commands; TVFocusGuideView sends setDestinations on TV.
jest.mock('react-native/Libraries/Components/View/ViewNativeComponent', () => ({
  ...jest.requireActual('@react-native/jest-preset/jest/mocks/ViewNativeComponent'),
  Commands: { setDestinations: jest.fn(), requestTVFocus: jest.fn() },
}));

jest.mock('@/api/probe', () => ({
  ...jest.requireActual('@/api/probe'),
  probeServer: jest.fn(async () => ({
    baseUrl: 'http://dev.test',
    name: 'Dev World',
    options: { serverName: 'Dev World', passwordLogin: true, passwordMinLength: 8 },
    insecure: false,
  })),
}));

const fakeServer = async () =>
  new Response(JSON.stringify({ error: { code: 'not_found', message: 'nope' } }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });

function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getString: (key) => map.get(key),
    set: (key, value) => void map.set(key, value),
    remove: (key) => map.delete(key),
  };
}

let store: AccountStore;

function RootLayout({ children }: { children?: ReactNode }) {
  return (
    <DesignProvider>
      <ToastProvider>
        <AccountsProvider store={store} queryClient={new QueryClient()} fetch={fakeServer}>
          {children ?? <Stack screenOptions={{ headerShown: false }} />}
        </AccountsProvider>
      </ToastProvider>
    </DesignProvider>
  );
}

// The signed-in part is stubbed: the test is about the stack the player's card leaves behind.
const routes = {
  _layout: RootLayout,
  '(app)/_layout': AppLayout,
  '(app)/index': () => <View testID="home-stub" />,
  '(app)/play/[playbackId]': () => null,
  '(onboarding)/profiles': ProfilesRoute,
  '(onboarding)/sign-in/change-password': ChangePasswordRoute,
};

const os = Platform.OS;
const handlers: (() => boolean | null | undefined)[] = [];

beforeEach(async () => {
  store = new AccountStore({ storage: memoryStorage(), vault: createMemoryVault() });
  global.fetch = jest.fn(fakeServer) as unknown as typeof fetch;
  await act(async () => {
    await setLanguagePreference('en');
  });
  Platform.OS = 'android';
  jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
  handlers.length = 0;
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, handler) => {
    const listener = handler as () => boolean;
    handlers.push(listener);
    return { remove: () => void handlers.splice(handlers.indexOf(listener), 1) };
  });
});
afterEach(() => {
  Platform.OS = os;
  jest.restoreAllMocks();
});

/** BackHandler's dispatch: newest listener first; when none handles the press the app exits. */
const pressBack = () =>
  act(() => void ([...handlers].reverse().some((handler) => handler()) || BackHandler.exitApp()));
/** tvOS Menu with focus on the form: only an `always` gate hands it to JS; otherwise tvOS leaves the app. */
const pressMenu = () =>
  currentMenuMode() === 'always' ? pressBack() : act(() => BackHandler.exitApp());

/** Home, then the player, which the card replaces with the password gate mid-play (A07): nothing is below. */
async function gateFromPlayer() {
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
  const router = renderRouter(routes, { initialUrl: '/' });
  await router;
  expect(await screen.findByTestId('home-stub')).toBeOnTheScreen();
  await act(async () => navigate.push('/play/p1'));
  // Mid-play the server asks for a new password; the card replaces the player with the gate (A07).
  let release: () => void = () => undefined;
  await act(async () => {
    release = holdForPlayer(anna.id);
    store.update(anna.id, { mustChangePassword: true });
  });
  await act(async () => {
    navigate.replace({ pathname: '/sign-in/change-password', params: { account: anna.id } });
    release();
  });
  await waitFor(() => expect(router.getPathname()).toBe('/sign-in/change-password'));
  expect(screen.getByTestId('change-password-screen')).toBeOnTheScreen();
  return { router };
}

it('Google TV: Back on the password gate the player card led to stays in the app (S4y item 8)', async () => {
  const exitApp = jest.spyOn(BackHandler, 'exitApp').mockImplementation(() => undefined);
  const { router } = await gateFromPlayer();

  await pressBack();
  expect(exitApp).not.toHaveBeenCalled();
  await waitFor(() => expect(router.getPathname()).toBe('/profiles'));
  expect(screen.getByTestId('profiles-screen')).toBeOnTheScreen();
});

it('Apple TV: Menu on the lonely password gate opens the profiles instead of leaving the app (Y16)', async () => {
  Platform.OS = 'ios';
  const exitApp = jest.spyOn(BackHandler, 'exitApp').mockImplementation(() => undefined);
  const { router } = await gateFromPlayer();

  await pressMenu();
  expect(exitApp).not.toHaveBeenCalled();
  await waitFor(() => expect(router.getPathname()).toBe('/profiles'));
  expect(screen.getByTestId('profiles-screen')).toBeOnTheScreen();
});

it('Back on the gate opened from the profile picker still just returns there', async () => {
  const exitApp = jest.spyOn(BackHandler, 'exitApp').mockImplementation(() => undefined);
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
  const router = renderRouter(routes, { initialUrl: '/profiles' });
  await router;
  await act(async () =>
    navigate.push({ pathname: '/sign-in/change-password', params: { account: mia.id } })
  );
  expect(await screen.findByTestId('change-password-screen')).toBeOnTheScreen();

  await pressBack();
  expect(exitApp).not.toHaveBeenCalled();
  await waitFor(() => expect(router.getPathname()).toBe('/profiles'));
  expect(navigate.canGoBack()).toBe(false);
});
