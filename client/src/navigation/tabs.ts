import { Bookmark, Film, House, Search, Settings, Tv, type LucideIcon } from '@/components/icons';

import type { UseTabsWithTriggersOptions } from 'expo-router/ui';
import type { AndroidSymbol, SFSymbol } from 'expo-symbols';

export type TabId = 'home' | 'search' | 'movies' | 'series' | 'mylist' | 'settings';

export type TabSpec = {
  id: TabId;
  /** Route group of the tab (its own stack). */
  name: `(${TabId})`;
  href: '/' | '/search' | '/movies' | '/series' | '/mylist' | '/settings';
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
    id: 'movies',
    name: '(movies)',
    href: '/movies',
    icon: Film,
    sf: { default: 'film', selected: 'film.fill' },
    md: 'movie',
  },
  {
    id: 'series',
    name: '(series)',
    href: '/series',
    icon: Tv,
    sf: { default: 'tv', selected: 'tv.fill' },
    md: 'tv',
  },
  {
    id: 'mylist',
    name: '(mylist)',
    href: '/mylist',
    icon: Bookmark,
    sf: { default: 'bookmark', selected: 'bookmark.fill' },
    md: 'bookmark',
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
