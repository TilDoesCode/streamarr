import { Redirect, Stack } from 'expo-router';
import { useEffect, useState, type ComponentProps } from 'react';
import { Platform, View } from 'react-native';

import { useSessionGate } from '@/accounts/accounts-provider';
import { ProfileSync } from '@/accounts/use-profile-sync';
import { PROBE_TIMEOUT_MS } from '@/connectivity/monitor';
import { useConnectivity } from '@/connectivity/provider';
import { useOfflineRedirect } from '@/connectivity/use-offline-redirect';
import { colors } from '@/theme';

// A tvOS modal lives outside the root view, where react-native-tvos listens for remote keys.
const APPLE_TV = Platform.OS === 'ios' && Platform.isTV;

export const unstable_settings = { initialRouteName: '(tabs)' };

/** A gate never waits for the first reachability answer longer than the probe itself may take. */
const REACHABILITY_WAIT_MS = PROBE_TIMEOUT_MS + 1_000;

/** True once the server's reachability is known, or after `REACHABILITY_WAIT_MS` (the probe never answered). */
function useReachabilityKnown(checked: boolean): boolean {
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    if (checked) return;
    const timer = setTimeout(() => setWaited(true), REACHABILITY_WAIT_MS);
    return () => clearTimeout(timer);
  }, [checked]);
  return checked || waited;
}

/** Signed-in part of the app; everyone else is sent to the right onboarding step. */
export default function AppLayout() {
  const gate = useSessionGate();
  const { offline, checked } = useConnectivity();
  const known = useReachabilityKnown(checked);
  useOfflineRedirect();
  if (gate.reason === 'no_accounts') return <Redirect href="/server" />;
  if (gate.reason === 'pick_profile') return <Redirect href="/profiles" />;
  // A cold start stays on the launch background until the first probe says which comes next (C1-24).
  if (gate.reason === 'change_password' && gate.account && !known)
    return <View testID="launch-pending" style={{ flex: 1, backgroundColor: colors.background }} />;
  // The change needs the server: offline the profile's downloads stay playable until it answers (C1-24).
  if (gate.reason === 'change_password' && gate.account && !offline)
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
        <Stack.Screen name="versions/[workId]" options={SHEET_OPTIONS} />
        <Stack.Screen name="download/[workId]" options={DOWNLOAD_SHEET_OPTIONS} />
        <Stack.Screen name="about/[kind]/[id]" options={SHEET_OPTIONS} />
        <Stack.Screen name="dev/player" />
        <Stack.Screen name="dev/downloads" />
        <Stack.Screen name="offline" options={{ animation: 'fade', gestureEnabled: false }} />
      </Stack>
    </>
  );
}

/** Version, Download and About sheets: iOS formSheet in Liquid Glass; TV, web and Android draw their own glass panel. */
const SHEET_OPTIONS: ComponentProps<typeof Stack.Screen>['options'] =
  Platform.OS === 'ios' && !Platform.isTV
    ? {
        presentation: 'formSheet',
        sheetAllowedDetents: [0.6, 1],
        sheetGrabberVisible: true,
        sheetCornerRadius: 28,
        // Transparent content: iOS 26 renders the formSheet itself in Liquid Glass.
        contentStyle: { backgroundColor: colors.scrim.clear },
      }
    : {
        // TV, web, Android tablets: the sheet draws its own glass over the page.
        presentation: 'transparentModal',
        animation: 'none',
        contentStyle: { backgroundColor: colors.scrim.clear },
      };

/** The download sheet opens at full height: its confirm button ends the list and sat below the 60 % detent. */
const DOWNLOAD_SHEET_OPTIONS: ComponentProps<typeof Stack.Screen>['options'] =
  Platform.OS === 'ios' && !Platform.isTV
    ? { ...SHEET_OPTIONS, sheetInitialDetentIndex: 'last' }
    : SHEET_OPTIONS;
