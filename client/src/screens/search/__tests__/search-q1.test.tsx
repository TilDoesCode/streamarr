import { QueryClient } from '@tanstack/react-query';
import { within } from '@testing-library/react-native';
import { Stack } from 'expo-router';
import { act, renderRouter, screen } from 'expo-router/testing-library';
import { StyleSheet } from 'react-native';

import { AccountStore, type KeyValueStorage } from '@/accounts/account-store';
import { AccountsProvider } from '@/accounts/accounts-provider';
import { createMemoryVault } from '@/accounts/types';
import { ToastProvider } from '@/components/ui/toast';
import { setLanguagePreference } from '@/i18n';
import { addRecentSearch } from '@/lib/recent-searches';
import { DesignProvider } from '@/theme';

import { appRoutes } from '../../../../jest/app-routes';

// expo-router/testing-library installs its own Reanimated mock, which lacks useReducedMotion and makeMutable.
const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function fakeServer(input: Request): Promise<Response> {
  const path = new URL(input.url).pathname;
  if (path === '/api/v1/viewer/catalog/search') return json(200, { items: [] });
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
function RootLayout() {
  return (
    <DesignProvider>
      <ToastProvider>
        <AccountsProvider store={store} queryClient={new QueryClient()} fetch={fakeServer}>
          <Stack screenOptions={{ headerShown: false }} />
        </AccountsProvider>
      </ToastProvider>
    </DesignProvider>
  );
}

beforeEach(async () => {
  store = new AccountStore({ storage: memoryStorage(), vault: createMemoryVault() });
  global.fetch = jest.fn(fakeServer) as unknown as typeof fetch;
  await act(async () => {
    await setLanguagePreference('en');
  });
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
  addRecentSearch(anna.id, 'sintel');
});

describe('Search page (Q1-21)', () => {
  it('says "Search" once: the heading, not again as the field label', async () => {
    await renderRouter({ _layout: RootLayout, ...appRoutes }, { initialUrl: '/search' });
    expect(await screen.findByTestId('search-field')).toHaveAccessibleName('Search');
    expect(within(screen.getByTestId('search-screen')).getAllByText('Search')).toHaveLength(1);
  });

  it('lines the Clear label up with the field edge', async () => {
    await renderRouter({ _layout: RootLayout, ...appRoutes }, { initialUrl: '/search' });
    const clear = await screen.findByTestId('search-recent-clear');
    // The ghost button's own padding (space.md of the shell scale) pulls back out of the row.
    const margin = StyleSheet.flatten(clear.props.style)?.marginRight;
    expect(typeof margin === 'number' && margin < 0).toBe(true);
  });
});
