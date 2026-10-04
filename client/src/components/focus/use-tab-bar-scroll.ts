import { useEffect, useRef } from 'react';
import { findNodeHandle, Platform, type ScrollView } from 'react-native';

import { attachTabBarScroll, detachTabBarScroll } from '@modules/tv-native';

const appleTV = () => Platform.OS === 'ios' && Platform.isTV;

/** Apple TV: the top tab bar slides away while this tab root's scroll view scrolls (and returns at the top). */
export function useTabBarScroll() {
  const ref = useRef<ScrollView>(null);
  useEffect(() => {
    if (!appleTV()) return;
    const tag = findNodeHandle(ref.current);
    if (tag == null) return;
    attachTabBarScroll(tag);
    return () => detachTabBarScroll(tag);
  }, []);
  return ref;
}
