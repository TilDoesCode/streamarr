import '@/global.css';
import '@/components/focus/tv-menu';

import { Stack } from 'expo-router';
import { ThemeProvider } from 'expo-router/react-navigation';
import { StatusBar } from 'expo-status-bar';
import { colorScheme } from 'nativewind';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { AccountsProvider } from '@/accounts/accounts-provider';
import { ToastProvider } from '@/components/ui/toast';
import { useDeviceLanguageSync } from '@/i18n';
import { colors, DesignProvider, NAV_THEME, useAppFonts } from '@/theme';

export { ErrorBoundary } from 'expo-router';

// Dark theme only: keeps NativeWind `dark:` variants active on every platform.
colorScheme.set('dark');

export default function RootLayout() {
  useDeviceLanguageSync();
  const fontsReady = useAppFonts();
  if (!fontsReady) return null;
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background }}>
      <ThemeProvider value={NAV_THEME}>
        <DesignProvider>
          <ToastProvider>
            <AccountsProvider>
              <StatusBar style="light" />
              <Stack
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor: colors.background },
                }}
              />
            </AccountsProvider>
          </ToastProvider>
        </DesignProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
