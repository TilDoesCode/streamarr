import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import {
  createContext,
  use,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Platform } from 'react-native';
import { createMMKV } from 'react-native-mmkv';

import type { ApiClient } from '@/api/client';
import { describeError } from '@/api/error-text';
import { createTimeoutFetch, type FetchLike } from '@/api/http';
import { useToast } from '@/components/ui/toast';
import { createQueryClient, setupQueryManagers } from '@/query/query-client';

import { createAccountsApi, type AccountsActions } from './accounts-api';
import { parseEndedReason } from './ended-reason';
import { ACCOUNTS_STORAGE_ID, AccountStore, type AccountsSnapshot } from './account-store';
import { followOtherTabs, tabSessionStorage } from './browser-tabs';
import { signInFlow } from './sign-in-flow';
import type { Account } from './types';
import { tokenVault } from './vault';

export type AccountsApi = AccountsActions & {
  /** The profile was picked in this app launch (web: this tab), so "Who's watching?" is not asked again. */
  profileChosen: boolean;
};

const AccountsContext = createContext<AccountsApi | null>(null);

// Web: "this launch" = this tab (sessionStorage); native: the process.
function readChosen(): boolean {
  if (Platform.OS !== 'web' || typeof sessionStorage === 'undefined') return false;
  return sessionStorage.getItem('streamarr.profileChosen') === '1';
}

function writeChosen(): void {
  if (Platform.OS === 'web' && typeof sessionStorage !== 'undefined')
    sessionStorage.setItem('streamarr.profileChosen', '1');
}

let defaultStore: AccountStore | undefined;

function getDefaultAccountStore(): AccountStore {
  if (defaultStore) return defaultStore;
  const web = Platform.OS === 'web' && typeof window !== 'undefined';
  defaultStore = new AccountStore({
    storage: createMMKV({ id: ACCOUNTS_STORAGE_ID }),
    vault: tokenVault,
    tabStorage: web ? tabSessionStorage(sessionStorage) : undefined,
  });
  if (web) followOtherTabs(defaultStore, window);
  return defaultStore;
}

export type AccountsProviderProps = {
  children: ReactNode;
  store?: AccountStore;
  queryClient?: QueryClient;
  fetch?: FetchLike;
};

export function AccountsProvider({
  children,
  store: injectedStore,
  queryClient: injectedClient,
  fetch: injectedFetch,
}: AccountsProviderProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const [profileChosen, setProfileChosen] = useState(readChosen);
  const [api] = useState(() =>
    createAccountsApi({
      store: injectedStore ?? getDefaultAccountStore(),
      queryClient: injectedClient ?? createQueryClient(),
      fetch: injectedFetch ?? createTimeoutFetch(),
      onChosen: () => {
        writeChosen();
        setProfileChosen(true);
      },
    })
  );

  useEffect(() => setupQueryManagers(), []);

  // Dev builds: lets Argent's debugger-evaluate inspect accounts and the query cache.
  useEffect(() => {
    if (__DEV__)
      Object.assign(globalThis, {
        __streamarr: { store: api.store, queryClient: api.queryClient, clientFor: api.clientFor },
      });
  }, [api]);

  useEffect(
    () =>
      api.store.onSessionEnded((account, endedReason) => {
        signInFlow.forgetPassword(account.id);
        api.queryClient.removeQueries({ queryKey: ['account', account.id] });
        toast.show({
          tone: 'error',
          message: t('accounts.sessionEnded', {
            name: account.displayName,
            reason: describeError(t, parseEndedReason(endedReason)).message,
          }),
        });
      }),
    [api, toast, t]
  );

  return (
    <AccountsContext value={{ ...api, profileChosen }}>
      <QueryClientProvider client={api.queryClient}>{children}</QueryClientProvider>
    </AccountsContext>
  );
}

export function useAccountsApi(): AccountsApi {
  const context = use(AccountsContext);
  if (!context) throw new Error('useAccountsApi must be used inside <AccountsProvider>');
  return context;
}

export function useAccounts(): AccountsSnapshot {
  const { store } = useAccountsApi();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** Who may use the app right now; `null` means onboarding (sign in, pick a profile, change password). */
export function useSessionGate(): { account: Account | null; reason: GateReason } {
  const { accounts, activeId } = useAccounts();
  const { profileChosen } = useAccountsApi();
  const active = accounts.find((account) => account.id === activeId) ?? null;
  const signedIn = accounts.filter((account) => account.signedIn);
  if (!accounts.length) return { account: null, reason: 'no_accounts' };
  if (!active || !active.signedIn) return { account: null, reason: 'pick_profile' };
  if (active.mustChangePassword) return { account: active, reason: 'change_password' };
  if (signedIn.length > 1 && !profileChosen) return { account: active, reason: 'pick_profile' };
  return { account: active, reason: 'ready' };
}

export type GateReason = 'no_accounts' | 'pick_profile' | 'change_password' | 'ready';

/** The active, signed-in account and its client (only inside the signed-in part of the app). */
export function useActiveAccount(): { account: Account; client: ApiClient } {
  const api = useAccountsApi();
  const { accounts, activeId } = useAccounts();
  const account = accounts.find((item) => item.id === activeId);
  if (!account) throw new Error('useActiveAccount needs an active account');
  return { account, client: api.clientFor(account.id) };
}
