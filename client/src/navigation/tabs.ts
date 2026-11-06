import {
  Bookmark,
  Download,
  Film,
  House,
  LibraryBig,
  Search,
  Settings,
  Tv,
  type LucideIcon,
} from '@/components/icons';

import type { UseTabsWithTriggersOptions } from 'expo-router/ui';
import type { AndroidSymbol, SFSymbol } from 'expo-symbols';

export type TabId = 'home' | 'search' | 'movies' | 'series' | 'mylist' | 'downloads' | 'settings';

export type TabSpec = {
  id: TabId;
  /** Route group of the tab (its own stack). */
  name: `(${TabId})`;
  href: '/' | '/search' | '/movies' | '/series' | '/mylist' | '/downloads' | '/settings';
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
    id: 'downloads',
    name: '(downloads)',
    href: '/downloads',
    icon: Download,
    sf: { default: 'arrow.down.circle', selected: 'arrow.down.circle.fill' },
    md: 'download',
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

/** Triggers for expo-router's headless tabs (TV rail, web sidebar): every route group, shown or not. */
export const TAB_TRIGGERS: UseTabsWithTriggersOptions['triggers'] = TABS.map((tab) => ({
  type: 'internal',
  name: tab.name,
  href: tab.href,
}));

/** Rail and web sidebar: Downloads only where downloads exist (not web, not Apple TV). */
export function railTabs(downloads: boolean): readonly TabSpec[] {
  return downloads ? TABS : TABS.filter((tab) => tab.id !== 'downloads');
}

/** A tab of the native tab bar; `labelKey` is its `tabs.*` key ("library" for the phones' merged Movies tab). */
export type NativeTab = TabSpec & { labelKey: TabId | 'library'; hidden: boolean };

/** Phones: Movies and Series become one Library tab (the Movies stack with a movies/series switch). */
const LIBRARY: Pick<TabSpec, 'icon' | 'sf' | 'md'> = {
  icon: LibraryBig,
  sf: { default: 'rectangle.stack', selected: 'rectangle.stack.fill' },
  md: 'video_library',
};

/** Native tab bar: phones Home, Search, Library, My List, Downloads, Settings; Apple TV keeps Movies and Series, no Downloads. */
export function nativeTabs({
  phone,
  downloads,
}: {
  phone: boolean;
  downloads: boolean;
}): readonly NativeTab[] {
  return TABS.map((tab): NativeTab => {
    if (phone && tab.id === 'movies')
      return { ...tab, ...LIBRARY, labelKey: 'library', hidden: false };
    const hidden = (phone && tab.id === 'series') || (tab.id === 'downloads' && !downloads);
    return { ...tab, labelKey: tab.id, hidden };
  });
}
