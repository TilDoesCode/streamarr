import { Redirect, usePathname } from 'expo-router';
import { Platform } from 'react-native';

import { useShell } from '@/shell/use-shell';

import { LargeShell } from './large-shell';
import { NativeTabsShell } from './native-tabs-shell';

/** Signed-in tab shell: the large-screen shell on Android TV and tablets; native tab bars on phones and Apple TV. */
export function AppTabs() {
  const { large } = useShell();
  const pathname = usePathname();
  const appleTV = Platform.OS === 'ios' && Platform.isTV;
  if (large && !appleTV) return <LargeShell />;
  // Phones show Series in the Library tab; their own (hidden) Series tab cannot be shown.
  if (!appleTV && pathname === '/series')
    return <Redirect href={{ pathname: '/movies', params: { kind: 'series' } }} />;
  return <NativeTabsShell />;
}
