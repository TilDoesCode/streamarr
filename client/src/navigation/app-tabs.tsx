import { Platform } from 'react-native';

import { useShell } from '@/shell/use-shell';

import { LargeShell } from './large-shell';
import { NativeTabsShell } from './native-tabs-shell';

/** Signed-in tab shell: the large-screen shell on Android TV and tablets; native tab bars on phones and Apple TV. */
export function AppTabs() {
  const { large } = useShell();
  const appleTV = Platform.OS === 'ios' && Platform.isTV;
  return large && !appleTV ? <LargeShell /> : <NativeTabsShell />;
}
