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

/** One page per title: a link to an open title returns to it, another title is pushed (Back returns). */
export function titleId({ params }: { params?: Record<string, unknown> }): string | undefined {
  return typeof params?.id === 'string' ? params.id : undefined;
}

/** The stack inside one tab; every tab but Settings also pushes the title screens. */
export function TabStack({ tab }: { tab: TabId }) {
  const { t } = useTranslation();
  const design = useDesign();
  const shell = useShell();
  // Phones use native headers; the large shell (TV, web, tablet) shows its own headings.
  const nativeHeaders = !design.isTV && Platform.OS !== 'web' && !shell.large;
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
          // iOS 26+: an opaque bar covers the large title that UIKit moves into the scroll view.
          ...(Platform.OS === 'ios'
            ? { headerStyle: { backgroundColor: colors.scrim.clear } }
            : null),
          title: t(`tabs.${tab}`),
          // Large shell: the tab's first screen sits on the shell's ambient backdrop.
          ...(shell.large ? { contentStyle: { backgroundColor: colors.scrim.clear } } : null),
        }}
      />
      {/* Stack children must be screens: no fragments. */}
      {browse ? <Stack.Screen name="movie/[id]" options={detailOptions} getId={titleId} /> : null}
      {browse ? (
        <Stack.Screen name="series/[id]/index" options={detailOptions} getId={titleId} />
      ) : null}
      {browse ? (
        <Stack.Screen
          name="series/[id]/season/[n]"
          // Web draws the season heading and back control on the page (like the large shell).
          options={{ headerShown: nativeHeaders }}
        />
      ) : null}
    </Stack>
  );
}
