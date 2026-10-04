import { router } from 'expo-router';

import { popToScreen } from '@modules/tv-native';
import { routerInternals } from '@/navigation/router-internals';
import { handleTitleLink } from '@/navigation/title-link-intent';

/** Incoming links: a title that is already open is returned to instead of being stacked again. */
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }) {
  if (initial) return path;
  try {
    return handleTitleLink(path, {
      ...routerInternals,
      open: (route) => router.navigate(route as never),
      popToScreen,
    });
  } catch {
    return path;
  }
}
