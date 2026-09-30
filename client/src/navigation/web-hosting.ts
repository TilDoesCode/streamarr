import { Platform } from 'react-native';

const DONE_KEY = 'streamarr.onboardingDone';

/** The page origin on web (a Streamarr server serving this app under /watch), else undefined. */
export function pageOrigin(): string | undefined {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return undefined;
  return window.location.origin;
}

function session(): Storage | undefined {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return undefined;
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

/** Web: onboarding finished in this tab, so browser Back into its pages returns to the app. */
export const onboardingExit = {
  mark: () => session()?.setItem(DONE_KEY, '1'),
  reset: () => session()?.removeItem(DONE_KEY),
  done: () => session()?.getItem(DONE_KEY) === '1',
};
