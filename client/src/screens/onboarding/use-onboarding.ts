import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { useAccountsApi } from '@/accounts/accounts-provider';
import type { SignInResult } from '@/accounts/auth-api';
import type { PasswordProblem } from '@/accounts/password-rules';
import { signInFlow } from '@/accounts/sign-in-flow';
import { probeServer, type ServerInfo } from '@/api/probe';
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

/** Leaves onboarding for the signed-in app with nothing to go back to. */
export function enterApp(router: ReturnType<typeof useRouter>): void {
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
