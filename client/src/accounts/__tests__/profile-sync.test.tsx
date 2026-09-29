import { QueryClient } from '@tanstack/react-query';
import { act, waitFor } from '@testing-library/react-native';

import { AccountStore, type KeyValueStorage } from '@/accounts/account-store';
import { AccountsProvider, useSessionGate } from '@/accounts/accounts-provider';
import { createMemoryVault } from '@/accounts/types';
import { ProfileSync } from '@/accounts/use-profile-sync';
import '@/i18n';
import { renderWithProviders } from '@/../jest/render';

function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getString: (key) => map.get(key),
    set: (key, value) => void map.set(key, value),
    remove: (key) => map.delete(key),
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function Harness() {
  const gate = useSessionGate();
  return gate.account ? <ProfileSync account={gate.account} /> : null;
}

// Real ticks: Response bodies resolve through them.
beforeEach(() => jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }));
afterEach(() => jest.useRealTimers());

it('re-syncs the profile every 5 minutes while the app stays in the foreground', async () => {
  const store = new AccountStore({ storage: memoryStorage(), vault: createMemoryVault() });
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
  let displayName = 'Anna';
  const fetch = jest.fn(async (input: Request) =>
    new URL(input.url).pathname === '/api/v1/viewer/me'
      ? json(200, { id: 'v-anna', username: 'anna', displayName, mustChangePassword: false })
      : json(404, { error: { code: 'not_found', message: 'nope' } })
  );
  const view = await renderWithProviders(
    <AccountsProvider store={store} queryClient={new QueryClient()} fetch={fetch}>
      <Harness />
    </AccountsProvider>
  );
  await act(() => jest.advanceTimersByTimeAsync(0));
  expect(fetch).toHaveBeenCalledTimes(1);

  displayName = 'Anna B.';
  await act(() => jest.advanceTimersByTimeAsync(4 * 60_000));
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(() => jest.advanceTimersByTimeAsync(60_000));
  expect(fetch).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(store.get(anna.id)).toMatchObject({ displayName: 'Anna B.' }));
  await view.unmount();
});
