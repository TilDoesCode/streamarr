import { House, Search, Settings, type LucideIcon } from 'lucide-react-native';

import type { UseTabsWithTriggersOptions } from 'expo-router/ui';
import type { AndroidSymbol, SFSymbol } from 'expo-symbols';

export type TabId = 'home' | 'search' | 'settings';

export type TabSpec = {
  id: TabId;
  /** Route group of the tab (its own stack). */
  name: `(${TabId})`;
  href: '/' | '/search' | '/settings';
  icon: LucideIcon;
  /** SF Symbol (iOS/tvOS NativeTabs). */
  sf: { default: SFSymbol; selected: SFSymbol };
  /** Material Symbol (Android NativeTabs). */
  md: AndroidSymbol;
};

export const TABS: readonly TabSpec[] = [
  {
    id: 'home',
    name: '(home)',
    href: '/',
    icon: House,
    sf: { default: 'house', selected: 'house.fill' },
    md: 'home',
  },
  {
    id: 'search',
    name: '(search)',
    href: '/search',
    icon: Search,
    sf: { default: 'magnifyingglass', selected: 'magnifyingglass' },
    md: 'search',
  },
  {
    id: 'settings',
    name: '(settings)',
    href: '/settings',
    icon: Settings,
    sf: { default: 'gearshape', selected: 'gearshape.fill' },
    md: 'settings',
  },
];

export const HOME_TAB = TABS[0]!;

/** Triggers for expo-router's headless tabs (TV rail, web sidebar). */
export const TAB_TRIGGERS: UseTabsWithTriggersOptions['triggers'] = TABS.map((tab) => ({
  type: 'internal',
  name: tab.name,
  href: tab.href,
}));

export function tabByName(name: string | undefined): TabSpec {
  return TABS.find((tab) => tab.name === name) ?? HOME_TAB;
}
