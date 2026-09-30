import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { Platform } from 'react-native';

const APP = 'Streamarr';

export function documentTitle(title: string | null | undefined): string {
  return title ? `${title} · ${APP}` : APP;
}

/** Web: the browser tab title of this route (e.g. the movie on a detail page). */
export function useScreenTitle(title: string | null | undefined): void {
  const full = documentTitle(title);
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS === 'web' && typeof document !== 'undefined') document.title = full;
    }, [full])
  );
}
