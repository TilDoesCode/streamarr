import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useTranslation } from 'react-i18next';
import { Platform } from 'react-native';

import { colors } from '@/theme';

import { TABS } from './tabs';

const android = Platform.OS === 'android';

/** Platform tab bar: Liquid Glass on iOS 26+ (sidebar on iPad), top tab bar on tvOS, Material bar on Android. */
export function NativeTabsShell() {
  const { t } = useTranslation();
  return (
    <NativeTabs
      sidebarAdaptable
      // iOS 26: the Liquid Glass tab bar shrinks while content scrolls down.
      minimizeBehavior="onScrollDown"
      backBehavior="initialRoute"
      tintColor={android ? colors.foreground.DEFAULT : colors.accent.DEFAULT}
      iconColor={{ default: colors.foreground.muted, selected: colors.foreground.DEFAULT }}
      labelStyle={{
        default: { color: colors.foreground.muted },
        selected: { color: colors.foreground.DEFAULT },
      }}
      // iOS keeps the system material (Liquid Glass); Android gets the dark surface.
      backgroundColor={android ? colors.surface.DEFAULT : undefined}
      indicatorColor={android ? colors.accent.muted : undefined}
      rippleColor={android ? colors.muted : undefined}>
      {TABS.map((tab) => (
        <NativeTabs.Trigger
          key={tab.name}
          name={tab.name}
          role={tab.id === 'search' && Platform.OS === 'ios' ? 'search' : undefined}>
          <NativeTabs.Trigger.Icon sf={tab.sf} md={tab.md} />
          <NativeTabs.Trigger.Label>{t(`tabs.${tab.id}`)}</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
      ))}
    </NativeTabs>
  );
}
