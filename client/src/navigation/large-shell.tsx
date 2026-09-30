import { useFocusEffect, usePathname, useRouter } from 'expo-router';
import { ThemeProvider } from 'expo-router/react-navigation';
import { TabSlot, useTabsWithTriggers } from 'expo-router/ui';
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { BackHandler, Platform, View } from 'react-native';

import { AmbientBackdrop, AmbientProvider } from '@/components/ambient';
import { useBackHandler } from '@/components/focus';
import { Dialog } from '@/components/ui/dialog';
import { ShellRail } from '@/shell/shell-rail';
import { SHELL } from '@/shell/shell-metrics';
import { useShell } from '@/shell/use-shell';
import { colors, DesignGutter, useDesign } from '@/theme';
import { SHELL_NAV_THEME } from '@/theme/navigation';

import { ScreenFocusProvider, useScreenFocusHost } from './screen-focus';
import { HOME_TAB, TAB_TRIGGERS, type TabSpec } from './tabs';
import { exitDialogReducer, tvBackAction } from './tv-back';

/** One large-screen shell for TV, web desktop and tablet: ambient backdrop, glass rail, tab content. */
export function LargeShell() {
  // Compiled memoization would keep NavigationContent (and the TabSlot) on stale state after a push.
  'use no memo';
  const { t } = useTranslation();
  const design = useDesign();
  const { s } = useShell();
  const router = useRouter();
  const pathname = usePathname();
  const { state, navigation, NavigationContent } = useTabsWithTriggers({
    triggers: TAB_TRIGGERS,
    // Web: every tab switch is a browser history entry; TV: Back from another tab returns Home.
    backBehavior: design.isTV ? 'firstRoute' : 'fullHistory',
  });
  const activeName = state.routes[state.index]?.name;
  const railFocused = useRef(false);
  // The dialog belongs to the path it opened on: any other screen opening (a deep link) closes it.
  const [exitAt, dispatchExit] = useReducer(exitDialogReducer, null);
  const exitOpen = exitAt === pathname;
  const setExitOpen = (open: boolean) =>
    dispatchExit(open ? { type: 'open', path: pathname } : { type: 'close' });
  useEffect(() => dispatchExit({ type: 'route', path: pathname }), [pathname]);
  const screens = useScreenFocusHost();

  useBackHandler(() => {
    const action = tvBackAction({
      railFocused: railFocused.current,
      canGoBack: router.canGoBack(),
      atHome: pathname === HOME_TAB.href,
    });
    if (action === 'closeRail') screens.focusActive();
    if (action === 'home') router.replace(HOME_TAB.href);
    if (action === 'confirmExit') setExitOpen(true);
    return action !== 'navigate';
  }, design.isTV);

  // A screen pushed over the shell (deep link to the player) hides the dialog's Modal; keep the state in step.
  useFocusEffect(useCallback(() => () => dispatchExit({ type: 'close' }), []));

  // Web keyboard shortcut: "/" opens Search (outside text fields).
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName ?? '');
      if (event.key !== '/' || typing || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      router.navigate('/search');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [router]);

  const select = (tab: TabSpec) => {
    if (design.isTV) {
      if (tab.name === activeName) return screens.focusActive();
      screens.focusNext();
    } else if (tab.name === activeName) {
      // The active tab again: back to its first screen.
      return router.navigate(tab.href);
    }
    navigation.dispatch({ type: 'JUMP_TO', payload: { name: tab.name } });
  };

  const rail = (
    <ShellRail
      activeName={activeName}
      onSelect={select}
      onFocusChange={(focused) => {
        railFocused.current = focused;
      }}
    />
  );
  // Web: the rail comes first in the DOM so the first Tab lands on it (it paints above the content via zIndex).
  const webFirst = Platform.OS === 'web';

  return (
    <NavigationContent>
      <AmbientProvider>
        <View style={{ flex: 1, backgroundColor: colors.background }}>
          <AmbientBackdrop testID="shell-ambient" />
          {webFirst ? rail : null}
          <View testID="tv-content" role="main" style={{ flex: 1 }}>
            <DesignGutter gutter={s(SHELL.row.left - SHELL.rail.width)} inset={s(SHELL.rail.width)}>
              <ScreenFocusProvider value={screens.host}>
                <ThemeProvider value={SHELL_NAV_THEME}>
                  <TabSlot />
                </ThemeProvider>
              </ScreenFocusProvider>
            </DesignGutter>
          </View>
          {webFirst ? null : rail}
        </View>
        <Dialog
          testID="exit-dialog"
          open={exitOpen}
          onClose={() => setExitOpen(false)}
          title={t('exit.title')}
          actions={[
            {
              label: t('common.cancel'),
              variant: 'secondary',
              preferred: true,
              onPress: () => setExitOpen(false),
            },
            { label: t('exit.confirm'), variant: 'primary', onPress: () => BackHandler.exitApp() },
          ]}
        />
      </AmbientProvider>
    </NavigationContent>
  );
}
