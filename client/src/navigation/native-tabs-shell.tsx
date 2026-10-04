import { usePathname, useRouter } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useTranslation } from 'react-i18next';
import { Platform } from 'react-native';

import { currentMenuMode, useBackHandler, useMenuClaim } from '@/components/focus';
import { colors } from '@/theme';

import { HOME_TAB, TABS } from './tabs';

const android = Platform.OS === 'android';
// tvOS draws a white pill behind the focused tab: its system label colours keep that legible.
const appleTV = Platform.OS === 'ios' && Platform.isTV;
// iPhone Home draws its hero behind the status bar; UIKit's automatic top inset would push it below.
const edgeToEdgeHome = Platform.OS === 'ios' && !Platform.isTV;
// iOS convention: the search-role tab sits at the trailing end of the bar.
const ORDERED =
  Platform.OS === 'ios'
    ? [...TABS.filter((tab) => tab.id !== 'search'), ...TABS.filter((tab) => tab.id === 'search')]
    : TABS;

/** Phone/Apple TV tab bar: Liquid Glass on iOS 26+, top tab bar on tvOS, Aurora-styled Material bar on Android. */
export function NativeTabsShell() {
  const { t } = useTranslation();
  return (
    <>
      {appleTV ? <AppleTvTabBack /> : null}
      <NativeTabs
        sidebarAdaptable
        // iOS 26: the Liquid Glass tab bar shrinks while content scrolls down.
        minimizeBehavior="onScrollDown"
        backBehavior="initialRoute"
        tintColor={
          android ? colors.foreground.DEFAULT : appleTV ? undefined : colors.accent.DEFAULT
        }
        iconColor={
          appleTV
            ? undefined
            : { default: colors.foreground.muted, selected: colors.foreground.DEFAULT }
        }
        labelStyle={
          appleTV
            ? undefined
            : {
                default: { color: colors.foreground.muted },
                selected: { color: colors.foreground.DEFAULT },
              }
        }
        // iOS keeps the system material (Liquid Glass); Android gets Aurora's solid glass and a glass pill.
        backgroundColor={android ? colors.glass.solid : undefined}
        indicatorColor={android ? colors.glass.strong : undefined}
        rippleColor={android ? colors.muted : undefined}>
        {ORDERED.map((tab) => (
          <NativeTabs.Trigger
            key={tab.name}
            name={tab.name}
            // Explicit: the native default is the label at creation and misses a live language switch.
            accessibilityLabel={t(`tabs.${tab.id}`)}
            role={tab.id === 'search' && Platform.OS === 'ios' ? 'search' : undefined}
            disableAutomaticContentInsets={edgeToEdgeHome && tab.id === 'home'}>
            <NativeTabs.Trigger.Icon sf={tab.sf} md={tab.md} />
            <NativeTabs.Trigger.Label>{t(`tabs.${tab.id}`)}</NativeTabs.Trigger.Label>
          </NativeTabs.Trigger>
        ))}
      </NativeTabs>
    </>
  );
}

/** Apple TV, like Android TV: Menu on another tab's bar goes to Start first; on Start's bar tvOS leaves the app. */
function AppleTvTabBack() {
  const pathname = usePathname();
  const router = useRouter();
  const atTabPage = pathname !== HOME_TAB.href && TABS.some((tab) => tab.href === pathname);
  useMenuClaim(atTabPage ? 'tabBar' : null);
  useBackHandler(() => {
    // A page step (library grid, sheet) claims Menu more strongly and runs its own handler.
    if (currentMenuMode() !== 'tabBar') return false;
    router.navigate(HOME_TAB.href);
    return true;
  }, atTabPage);
  return null;
}
