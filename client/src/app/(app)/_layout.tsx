import { Redirect, Stack } from 'expo-router';

import { useSessionGate } from '@/accounts/accounts-provider';
import { ProfileSync } from '@/accounts/use-profile-sync';
import { colors } from '@/theme';

/** Signed-in part of the app; everyone else is sent to the right onboarding step. */
export default function AppLayout() {
  const gate = useSessionGate();
  if (gate.reason === 'no_accounts') return <Redirect href="/server" />;
  if (gate.reason === 'pick_profile') return <Redirect href="/profiles" />;
  if (gate.reason === 'change_password' && gate.account)
    return (
      <Redirect
        href={{ pathname: '/sign-in/change-password', params: { account: gate.account.id } }}
      />
    );
  return (
    <>
      {gate.account ? <ProfileSync account={gate.account} /> : null}
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
      />
    </>
  );
}
