import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useTranslation } from 'react-i18next';
import { Platform } from 'react-native';

import { colors } from '@/theme';

import { TABS } from './tabs';

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
    <NativeTabs
      sidebarAdaptable
      // iOS 26: the Liquid Glass tab bar shrinks while content scrolls down.
      minimizeBehavior="onScrollDown"
      backBehavior="initialRoute"
      tintColor={android ? colors.foreground.DEFAULT : appleTV ? undefined : colors.accent.DEFAULT}
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
          role={tab.id === 'search' && Platform.OS === 'ios' ? 'search' : undefined}
          disableAutomaticContentInsets={edgeToEdgeHome && tab.id === 'home'}>
          <NativeTabs.Trigger.Icon sf={tab.sf} md={tab.md} />
          <NativeTabs.Trigger.Label>{t(`tabs.${tab.id}`)}</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
      ))}
    </NativeTabs>
  );
}
