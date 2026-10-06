import { QueryClient } from '@tanstack/react-query';
import { act, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { AccountStore, type KeyValueStorage } from '@/accounts/account-store';
import { AccountsProvider, useSessionGate } from '@/accounts/accounts-provider';
import { holdForPlayer } from '@/accounts/player-hold';
import { createMemoryVault } from '@/accounts/types';
import i18n from '@/i18n';
import { renderWithProviders } from '@/../jest/render';

function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getString: (key) => map.get(key),
    set: (key, value) => void map.set(key, value),
    remove: (key) => map.delete(key),
  };
}

function Gate() {
  return <Text testID="gate">{useSessionGate().reason}</Text>;
}

async function signedIn() {
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
  await renderWithProviders(
    <AccountsProvider store={store} queryClient={new QueryClient()} fetch={jest.fn()}>
      <Gate />
    </AccountsProvider>
  );
  return { store, anna };
}

describe('a session that ends while the player is open (S9b A05)', () => {
  it('the player keeps its screen and explains it on its own card: no profile picker, no toast, until it closes', async () => {
    await i18n.changeLanguage('en');
    const { store, anna } = await signedIn();
    const release = holdForPlayer(anna.id);
    await act(() => store.signOut(anna.id, 'refresh_session_expired'));
    expect(screen.getByTestId('gate')).toHaveTextContent('ready');
    expect(screen.queryByText(/sign-in has expired/i)).toBeNull();
    await act(async () => release());
    expect(screen.getByTestId('gate')).toHaveTextContent('pick_profile');
  });

  it('without an open player the session end goes to the profile picker with the toast, as before', async () => {
    await i18n.changeLanguage('en');
    const { store, anna } = await signedIn();
    await act(() => store.signOut(anna.id, 'refresh_session_expired'));
    expect(screen.getByTestId('gate')).toHaveTextContent('pick_profile');
    expect(screen.getByText(/sign-in has expired/i)).toBeOnTheScreen();
  });
});
