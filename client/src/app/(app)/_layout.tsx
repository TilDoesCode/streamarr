import { Redirect, Stack } from 'expo-router';
import { Platform } from 'react-native';

import { useSessionGate } from '@/accounts/accounts-provider';
import { ProfileSync } from '@/accounts/use-profile-sync';
import { colors } from '@/theme';

// A tvOS modal lives outside the root view, where react-native-tvos listens for remote keys.
const APPLE_TV = Platform.OS === 'ios' && Platform.isTV;

export const unstable_settings = { initialRouteName: '(tabs)' };

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
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
        }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen
          name="play/[playbackId]"
          options={{
            presentation: APPLE_TV ? 'card' : 'fullScreenModal',
            animation: 'fade',
            contentStyle: { backgroundColor: colors.video },
          }}
        />
        <Stack.Screen
          name="versions/[workId]"
          options={{
            presentation: 'formSheet',
            sheetAllowedDetents: [0.6, 1],
            sheetGrabberVisible: true,
            sheetCornerRadius: 28,
            // Transparent content: iOS 26 renders the formSheet itself in Liquid Glass.
            contentStyle: { backgroundColor: colors.scrim.clear },
          }}
        />
        <Stack.Screen name="dev/player" />
      </Stack>
    </>
  );
}
