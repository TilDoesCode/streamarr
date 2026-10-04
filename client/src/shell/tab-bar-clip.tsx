import type { ReactNode } from 'react';
import { Platform, View } from 'react-native';

import { SHELL } from './shell-metrics';
import { useShell } from './use-shell';

/** Apple TV: a tab page starts at the floating tab bar's bottom edge, so it scrolls away there instead of beneath it. */
export function TabBarClip({ children }: { children: ReactNode }) {
  const { s } = useShell();
  if (Platform.OS !== 'ios' || !Platform.isTV) return children;
  return (
    <View testID="tab-bar-clip" style={{ flex: 1, marginTop: s(SHELL.tvosTabBarBottom) }}>
      {children}
    </View>
  );
}
