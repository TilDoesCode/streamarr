import { router } from 'expo-router';
import { store } from 'expo-router/build/global-state/router-store';

import { popToScreen } from '@modules/tv-native';
import { titleLinkAction, type LinkState } from '@/navigation/title-link';

// The stack's pop animation: a tab switch afterwards must see the synced state.
const AFTER_POP_MS = 700;

/** Incoming links: a title that is already open is returned to instead of being stacked again. */
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }) {
  if (initial) return path;
  try {
    const route = path.replace(/^[a-z][\w+.-]*:\/\/[^/]*/i, '') || '/';
    const linking = store.linking;
    const target = linking?.getStateFromPath?.(route, linking.config) as LinkState | undefined;
    const current = store.navigationRef.getRootState?.() as LinkState | undefined;
    const action = titleLinkAction(target, current);
    if (action.type === 'open') return path;
    const show = () => {
      if (!action.shown) router.navigate(route as never);
    };
    if (action.type === 'stay') {
      show();
      return null;
    }
    const popInJs = () =>
      store.navigationRef.dispatch({
        type: 'POP',
        payload: { count: action.count },
        target: action.stackKey,
      });
    // Apple TV: a JS pop drops pages that were linked in, so the native stack pops like Menu does.
    const native = popToScreen(action.screenTestID);
    if (native) {
      void native.then((popped) => {
        if (!popped) popInJs();
        setTimeout(show, AFTER_POP_MS);
      });
    } else {
      popInJs();
      show();
    }
    return null;
  } catch {
    return path;
  }
}
