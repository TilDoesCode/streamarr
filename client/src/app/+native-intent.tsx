import { router } from 'expo-router';

import { popToScreen } from '@modules/tv-native';
import { libraryLink } from '@/navigation/library-link';
import { routerInternals } from '@/navigation/router-internals';
import { handleTitleLink } from '@/navigation/title-link-intent';

/** Incoming links: a title that is already open is returned to instead of being stacked again. */
export function redirectSystemPath({ path: link, initial }: { path: string; initial: boolean }) {
  const path = libraryLink(link);
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
