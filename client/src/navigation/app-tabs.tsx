import { Platform } from 'react-native';

import { NativeTabsShell } from './native-tabs-shell';
import { TvRailShell } from './tv-rail-shell';

/** Signed-in tab shell: Android TV rail; native tab bars on iPhone, iPad, Apple TV and Android phones. */
export function AppTabs() {
  return Platform.isTV && Platform.OS === 'android' ? <TvRailShell /> : <NativeTabsShell />;
}
