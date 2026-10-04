import { store } from 'expo-router/build/global-state/router-store';

import type { LinkState } from './title-link';

type NavigationAction = { type: string; payload?: object; target?: string };

/** expo-router has no public API for a path's state outside components: one adapter, pinned by its test. */
export const routerInternals = {
  stateFromPath(route: string): LinkState | undefined {
    const linking = store.linking;
    return linking?.getStateFromPath?.(route, linking.config) as LinkState | undefined;
  },
  linkingConfig(): object | undefined {
    return store.linking?.config;
  },
  rootState(): LinkState | undefined {
    return store.navigationRef.getRootState?.() as LinkState | undefined;
  },
  dispatch(action: NavigationAction): void {
    store.navigationRef.dispatch(action as never);
  },
  /** Calls `listener` on every navigation state change; returns the unsubscribe. */
  onState(listener: () => void): () => void {
    return store.navigationRef.addListener('state', listener);
  },
};
