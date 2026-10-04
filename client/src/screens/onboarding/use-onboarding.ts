import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Platform } from 'react-native';

import { useAccountsApi, useSessionGate } from '@/accounts/accounts-provider';
import type { SignInResult } from '@/accounts/auth-api';
import type { PasswordProblem } from '@/accounts/password-rules';
import { signInFlow } from '@/accounts/sign-in-flow';
import { probeServer, type ServerInfo } from '@/api/probe';
import { onboardingExit } from '@/navigation/web-hosting';
import { queryKeys } from '@/query/keys';
import { STALE } from '@/query/query-client';

/** Auth options of a server (seeded by the server step, re-probed after a reload). */
export function useServerInfo(serverUrl: string | undefined) {
  return useQuery({
    queryKey: queryKeys.serverOptions(serverUrl ?? ''),
    queryFn: () => probeServer(serverUrl ?? ''),
    enabled: !!serverUrl,
    staleTime: STALE.serverOptions,
    retry: false,
  });
}

type NavigationEntry = { type?: string; name?: string };

/** Web: the page load itself opened an onboarding address (link, typed URL, reload), not Back/Forward. */
export function openedAtOnboarding(entry: NavigationEntry | undefined): boolean {
  if (!entry?.name || entry.type === 'back_forward') return false;
  try {
    return /\/(sign-in|server)(\/|$)/.test(new URL(entry.name).pathname);
  } catch {
    return false;
  }
}

function pageLoadEntry(): NavigationEntry | undefined {
  if (Platform.OS !== 'web' || typeof performance === 'undefined') return undefined;
  return performance.getEntriesByType?.('navigation')[0] as NavigationEntry | undefined;
}

// Set once this page load has left onboarding, so later Back entries to it redirect again.
let pageLoadUsed = false;

/** Web: Back into a finished onboarding returns to the app; a fresh link to it (add a profile) shows it. */
export function leftOnboarding(state: { ready: boolean; done: boolean; opened: boolean }): boolean {
  return state.ready && state.done && !state.opened;
}

export function useLeftOnboarding(): boolean {
  const gate = useSessionGate();
  return leftOnboarding({
    ready: gate.reason === 'ready',
    done: onboardingExit.done(),
    opened: !pageLoadUsed && openedAtOnboarding(pageLoadEntry()),
  });
}

/** Leaves onboarding for the signed-in app with nothing to go back to. */
export function enterApp(router: ReturnType<typeof useRouter>): void {
  pageLoadUsed = true;
  onboardingExit.mark();
  if (router.canDismiss()) router.dismissAll();
  router.replace('/');
}

type Authenticated = Extract<SignInResult, { kind: 'authenticated' }>;

/** Stores the account, makes it active and continues to the password change or into the app. */
export function useCompleteSignIn() {
  const api = useAccountsApi();
  const router = useRouter();
  return async (server: ServerInfo, result: Authenticated, password?: string) => {
    const account = await api.completeSignIn(
      { url: server.baseUrl, name: server.name },
      result.viewer,
      result.tokens
    );
    signInFlow.clearSecondFactor();
    if (account.mustChangePassword) {
      if (password) signInFlow.rememberPassword(account.id, password);
      if (router.canDismiss()) router.dismissAll();
      router.replace({ pathname: '/sign-in/change-password', params: { account: account.id } });
      return;
    }
    enterApp(router);
  };
}

/** Localized text for a client-side password problem. */
export function usePasswordProblemText() {
  const { t } = useTranslation();
  return (problem: PasswordProblem): string => {
    switch (problem.kind) {
      case 'tooShort':
        return t('onboarding.validation.tooShort', { min: problem.min });
      case 'tooLong':
        return t('onboarding.validation.tooLong', { max: problem.max });
      case 'sameAsUsername':
        return t('onboarding.validation.sameAsUsername');
      case 'repetitive':
        return t('onboarding.validation.repetitive');
      case 'mismatch':
        return t('onboarding.validation.mismatch');
    }
  };
}
