import { NavigationContext } from 'expo-router/react-navigation';
import { createContext, use, useCallback, useSyncExternalStore } from 'react';

/** Lets a subtree pause infinite loader animations (Android UI automation needs an idle screen). */
export const LoaderMotionContext = createContext(true);

/** Whether an endless loader may animate: allowed here and its screen still focused (F12, R1). */
export function useLoaderMotion(): boolean {
  const allowed = use(LoaderMotionContext);
  const navigation = use(NavigationContext);
  // Blur comes when a close starts, before its surface goes: the UI thread stops updating the view first.
  const subscribe = useCallback(
    (changed: () => void) => {
      if (!navigation) return () => undefined;
      const offFocus = navigation.addListener('focus', changed);
      const offBlur = navigation.addListener('blur', changed);
      return () => {
        offFocus();
        offBlur();
      };
    },
    [navigation]
  );
  const focused = useSyncExternalStore(subscribe, () => navigation?.isFocused() ?? true);
  return allowed && focused;
}
