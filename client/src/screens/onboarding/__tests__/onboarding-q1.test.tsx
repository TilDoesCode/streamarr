import { QueryClient } from '@tanstack/react-query';
import { userEvent, within } from '@testing-library/react-native';
import { Stack } from 'expo-router';
import { act, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import type { ReactNode } from 'react';
import { TextInput } from 'react-native';

import { AccountStore, type KeyValueStorage } from '@/accounts/account-store';
import { AccountsProvider } from '@/accounts/accounts-provider';
import { createMemoryVault } from '@/accounts/types';
import { ToastProvider } from '@/components/ui/toast';
import { setLanguagePreference } from '@/i18n';
import { DesignProvider } from '@/theme';

import { appRoutes } from '../../../../jest/app-routes';
import { keyboardEvents, revealScrollY, scrollContent } from '../auth-scaffold';
import { leftOnboarding, openedAtOnboarding } from '../use-onboarding';

// expo-router/testing-library installs its own Reanimated mock, which lacks useReducedMotion and makeMutable.
const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

jest.mock('@/api/probe', () => ({
  ...jest.requireActual('@/api/probe'),
  probeServer: jest.fn(async (input: string) => {
    const { AppError: Err } = jest.requireActual('@/api/errors');
    if (input.includes('down.test')) throw new Err('network_unreachable');
    return {
      baseUrl: 'http://dev.test',
      name: 'Dev World',
      options: { serverName: 'Dev World', passwordLogin: true, passwordMinLength: 8 },
      insecure: false,
    };
  }),
}));

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function fakeServer(input: Request): Promise<Response> {
  const path = new URL(input.url).pathname;
  if (path === '/api/v1/viewer/watch/resume') return json(200, []);
  if (path === '/api/v1/viewer/watch/next-up') return json(200, { items: [] });
  if (path === '/api/v1/viewer/catalog/discover') return json(200, { rows: [] });
  if (path === '/api/v1/viewer/auth/login')
    return json(401, { error: { code: 'invalid_credentials', message: 'no' } });
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

const routes = { _layout: RootLayout, ...appRoutes };
const SIGN_IN = '/sign-in?server=http%3A%2F%2Fdev.test';

async function signInAnna() {
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
}

beforeEach(async () => {
  store = new AccountStore({ storage: memoryStorage(), vault: createMemoryVault() });
  global.fetch = jest.fn(fakeServer) as unknown as typeof fetch;
  await act(async () => {
    await setLanguagePreference('en');
  });
});

describe('sign-in link while a profile is active (Q1-09)', () => {
  it('shows a link opened by the page load; Back into old entries still returns to the app', () => {
    const link = { type: 'navigate', name: 'https://tv.example/watch/sign-in?server=x&login=kind' };
    expect(openedAtOnboarding(link)).toBe(true);
    expect(openedAtOnboarding({ type: 'reload', name: 'http://localhost:8081/server' })).toBe(true);
    expect(openedAtOnboarding({ type: 'back_forward', name: link.name })).toBe(false);
    expect(openedAtOnboarding({ type: 'navigate', name: 'http://localhost:8081/' })).toBe(false);
    expect(openedAtOnboarding(undefined)).toBe(false);

    expect(leftOnboarding({ ready: true, done: true, opened: true })).toBe(false);
    expect(leftOnboarding({ ready: true, done: true, opened: false })).toBe(true);
    expect(leftOnboarding({ ready: false, done: true, opened: false })).toBe(false);
  });

  it('offers a way back to the active profile', async () => {
    await signInAnna();
    const user = userEvent.setup();
    const router = renderRouter(routes, { initialUrl: SIGN_IN });
    await router;
    await user.press(await screen.findByTestId('sign-in-back-to-app'));
    await waitFor(() => expect(router.getPathname()).toBe('/'));
    expect(await screen.findByTestId('home-screen')).toBeOnTheScreen();
  });

  it('the server step reached while a profile is signed in offers the way back too (F11)', async () => {
    await signInAnna();
    const user = userEvent.setup();
    const router = renderRouter(routes, { initialUrl: '/server' });
    await router;
    await user.press(await screen.findByTestId('server-back-to-app'));
    await waitFor(() => expect(router.getPathname()).toBe('/'));
    expect(await screen.findByTestId('home-screen')).toBeOnTheScreen();
  });

  it('the server step has no way back while the profile picker is due (signed out, verify A4)', async () => {
    await signInAnna();
    await act(async () => {
      await store.signOut(store.getSnapshot().activeId!, 'refresh_session_expired');
    });
    const router = renderRouter(routes, { initialUrl: '/server' });
    await router;
    expect(await screen.findByTestId('server-connect')).toBeOnTheScreen();
    expect(screen.queryByTestId('server-back-to-app')).toBeNull();
  });

  it('the server step has no way back without a signed-in profile (F11)', async () => {
    const router = renderRouter(routes, { initialUrl: '/server' });
    await router;
    expect(await screen.findByTestId('server-connect')).toBeOnTheScreen();
    expect(screen.queryByTestId('server-back-to-app')).toBeNull();
  });

  it('has no way back without a signed-in profile', async () => {
    const router = renderRouter(routes, { initialUrl: SIGN_IN });
    await router;
    expect(await screen.findByTestId('sign-in-login')).toBeOnTheScreen();
    expect(screen.queryByTestId('sign-in-back-to-app')).toBeNull();
  });
});

describe('wrong password (Q1-10)', () => {
  it('puts focus back into the password field with the text selected', async () => {
    const proto = TextInput.prototype as unknown as {
      focus: jest.Mock;
      setSelection?: jest.Mock;
    };
    proto.setSelection = jest.fn();
    const user = userEvent.setup();
    const router = renderRouter(routes, { initialUrl: SIGN_IN });
    await router;
    await user.type(await screen.findByTestId('sign-in-login'), 'anna');
    await user.type(screen.getByTestId('sign-in-password'), 'wrong');
    proto.focus.mockClear();
    await user.press(screen.getByTestId('sign-in-submit'));
    expect(await screen.findByText('Wrong username or password')).toBeOnTheScreen();
    const focused = proto.focus.mock.contexts as { props: { testID?: string } }[];
    expect(focused.map((input) => input.props.testID)).toContain('sign-in-password');
    expect(proto.setSelection).toHaveBeenCalledWith(0, 5);
    delete proto.setSelection;
  });
});

describe('unreachable server (Q1-11)', () => {
  it('goes back to the server step with the linked address kept', async () => {
    const user = userEvent.setup();
    const router = renderRouter(routes, {
      initialUrl: '/sign-in?server=http%3A%2F%2Fdown.test%3A39399',
    });
    await router;
    const error = await screen.findByTestId('sign-in-server-error');
    await user.press(within(error).getByRole('button', { name: 'Go back' }));
    await waitFor(() => expect(router.getPathname()).toBe('/server'));
    expect(screen.getByTestId('server-address')).toHaveDisplayValue('http://down.test:39399');
  });
});

describe('keyboard on handheld sign-in (Q1-34)', () => {
  it('listens to the keyboard events Android sends', () => {
    expect(keyboardEvents('android')).toEqual({ show: 'keyboardDidShow', hide: 'keyboardDidHide' });
    expect(keyboardEvents('ios')).toEqual({ show: 'keyboardWillShow', hide: 'keyboardWillHide' });
  });

  it('scrolls the focused field to the top so the button under it shows', () => {
    // Password field at 420 in 700 of content, 380 left above the keyboard.
    expect(
      revealScrollY({ fieldTop: 420, margin: 32, viewport: 380, content: 700, current: 0 })
    ).toBe(320);
    // Never past the end of the content.
    expect(
      revealScrollY({ fieldTop: 600, margin: 32, viewport: 380, content: 700, current: 0 })
    ).toBe(320);
    // Everything fits: no scroll.
    expect(
      revealScrollY({ fieldTop: 200, margin: 32, viewport: 600, content: 500, current: 0 })
    ).toBeNull();
    // Already there.
    expect(
      revealScrollY({ fieldTop: 420, margin: 32, viewport: 380, content: 700, current: 320 })
    ).toBeNull();
  });

  it('measures against the scroll content ref, not its node handle (Fabric measureLayout)', () => {
    const content = { measure: jest.fn() };
    const scroll = { getInnerViewRef: () => content, getInnerViewNode: () => 42 };
    expect(scrollContent(scroll as never)).toBe(content);
    expect(scrollContent(null)).toBeNull();
  });
});
