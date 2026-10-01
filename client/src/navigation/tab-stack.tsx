import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Platform } from 'react-native';

import { useShell } from '@/shell/use-shell';
import { colors, useDesign } from '@/theme';

import { ScreenFocusScope } from './screen-focus';
import type { TabId } from './tabs';

const ROOT_SCREEN: Record<TabId, string> = {
  home: 'index',
  search: 'search',
  movies: 'movies',
  series: 'series',
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

/** The stack inside one tab; every tab but Settings also pushes the title screens. */
export function TabStack({ tab }: { tab: TabId }) {
  const { t } = useTranslation();
  const design = useDesign();
  const shell = useShell();
  // Phones and tablets use native headers; TV and web show their own headings and the shell.
  const nativeHeaders = !design.isTV && Platform.OS !== 'web';
  // Phones: iOS keeps the native Liquid Glass header; Android and web draw a glass back button over the art.
  const detailHeader = !design.isTV && !shell.large && Platform.OS === 'ios';
  const detailOptions = {
    ...ARTWORK_HEADER(detailHeader),
    ...(shell.large ? { contentStyle: { backgroundColor: colors.scrim.clear } } : null),
  };
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
          // Library pages draw their own title line (title + sort).
          headerShown: nativeHeaders && (tab === 'search' || tab === 'settings'),
          headerLargeTitleEnabled: Platform.OS === 'ios',
          title: t(`tabs.${tab}`),
          // Large shell: the tab's first screen sits on the shell's ambient backdrop.
          ...(shell.large ? { contentStyle: { backgroundColor: colors.scrim.clear } } : null),
        }}
      />
      {/* Stack children must be screens: no fragments. */}
      {browse ? <Stack.Screen name="movie/[id]" options={detailOptions} /> : null}
      {browse ? <Stack.Screen name="series/[id]/index" options={detailOptions} /> : null}
      {browse ? (
        <Stack.Screen
          name="series/[id]/season/[n]"
          options={{ headerShown: !design.isTV && !shell.large }}
        />
      ) : null}
    </Stack>
  );
}
