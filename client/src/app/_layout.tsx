import '@/global.css';
import '@/components/focus/tv-menu';

import { Stack } from 'expo-router';
import { ThemeProvider } from 'expo-router/react-navigation';
import { StatusBar } from 'expo-status-bar';
import { colorScheme } from 'nativewind';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { AccountsProvider } from '@/accounts/accounts-provider';
import { ToastProvider } from '@/components/ui/toast';
import { ProgressSync } from '@/connectivity/progress-sync';
import { ConnectivityProvider } from '@/connectivity/provider';
import { DownloadsProvider } from '@/downloads/provider';
import { useDeviceLanguageSync } from '@/i18n';
import { MotionConfig } from '@/performance';
import { releaseLaunchOrientation } from '@/lib/launch-orientation';
import { colors, DesignProvider, NAV_THEME, useAppFonts } from '@/theme';

export { ErrorBoundary } from 'expo-router';

// Dark theme only: keeps NativeWind `dark:` variants active on every platform.
colorScheme.set('dark');

export default function RootLayout() {
  useDeviceLanguageSync();
  useEffect(
    () =>
      releaseLaunchOrientation(() => import('expo-screen-orientation'), {
        os: Platform.OS,
        isTV: Platform.isTV,
      }),
    []
  );
  const fontsReady = useAppFonts();
  if (!fontsReady) return null;
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background }}>
      <ThemeProvider value={NAV_THEME}>
        <DesignProvider>
          <ToastProvider>
            <AccountsProvider>
              <ConnectivityProvider>
                <DownloadsProvider>
                  <StatusBar style="light" />
                  <MotionConfig />
                  <ProgressSync />
                  <Stack
                    screenOptions={{
                      headerShown: false,
                      contentStyle: { backgroundColor: colors.background },
                    }}
                  />
                </DownloadsProvider>
              </ConnectivityProvider>
            </AccountsProvider>
          </ToastProvider>
        </DesignProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
