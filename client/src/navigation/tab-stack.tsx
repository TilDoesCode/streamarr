import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Platform } from 'react-native';

import { colors, useDesign } from '@/theme';

import { ScreenFocusScope } from './screen-focus';
import type { TabId } from './tabs';

const ROOT_SCREEN: Record<TabId, string> = {
  home: 'index',
  search: 'search',
  settings: 'settings',
};

// Artwork screens: transparent native header (iOS 26 draws Liquid Glass bar buttons over the artwork).
const ARTWORK_HEADER = (shown: boolean) => ({
  headerShown: shown,
  headerTransparent: true,
  headerStyle: { backgroundColor: colors.scrim.clear },
  headerBlurEffect: 'none' as const,
  title: '',
});

/** The stack inside one tab; Home and Search also push the title screens. */
export function TabStack({ tab }: { tab: TabId }) {
  const { t } = useTranslation();
  const design = useDesign();
  // Phones and tablets use native headers; TV and web show their own headings and the shell.
  const nativeHeaders = !design.isTV && Platform.OS !== 'web';
  const detailHeader = !design.isTV;
  const browse = tab !== 'settings';
  return (
    <Stack
      screenLayout={({ children }) => <ScreenFocusScope>{children}</ScreenFocusScope>}
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.background },
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.foreground.DEFAULT,
        headerShadowVisible: false,
        headerBackButtonDisplayMode: 'minimal',
        animation: design.isTV ? 'fade' : 'default',
      }}>
      <Stack.Screen
        name={ROOT_SCREEN[tab]}
        options={{
          headerShown: nativeHeaders && tab !== 'home',
          headerLargeTitleEnabled: Platform.OS === 'ios',
          title: t(`tabs.${tab}`),
        }}
      />
      {/* Stack children must be screens: no fragments. */}
      {browse ? <Stack.Screen name="movie/[id]" options={ARTWORK_HEADER(detailHeader)} /> : null}
      {browse ? (
        <Stack.Screen name="series/[id]/index" options={ARTWORK_HEADER(detailHeader)} />
      ) : null}
      {browse ? (
        <Stack.Screen name="series/[id]/season/[n]" options={{ headerShown: detailHeader }} />
      ) : null}
    </Stack>
  );
}
