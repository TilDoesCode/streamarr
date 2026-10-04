import { titleLinkAction, routeFromUrl, type LinkState } from './title-link';

// A pop that has not reached the navigation state by then is taken as done (slow device): the tab is shown anyway.
export const POP_SYNC_TIMEOUT_MS = 2000;

export type TitleLinkDeps = {
  stateFromPath(route: string): LinkState | undefined;
  rootState(): LinkState | undefined;
  dispatch(action: { type: string; payload?: object; target?: string }): void;
  onState(listener: () => void): () => void;
  navigate(route: string): void;
  /** The native pop (Apple TV), null where the stack is popped in JS. */
  popToScreen(testID: string, count: number): Promise<boolean> | null;
};

/** Incoming links: a title already open in its stack is returned to; returns the path the router still has to open. */
export function handleTitleLink(url: string, deps: TitleLinkDeps): string | null {
  const route = routeFromUrl(url);
  const target = deps.stateFromPath(route);
  const action = titleLinkAction(target, deps.rootState());
  if (action.type === 'open') return url;
  const show = () => {
    if (!action.shown) deps.navigate(route);
  };
  if (action.type === 'stay') {
    show();
    return null;
  }
  const popInJs = () =>
    deps.dispatch({ type: 'POP', payload: { count: action.count }, target: action.stackKey });
  const native = deps.popToScreen(action.screenTestID, action.count);
  if (!native) {
    popInJs();
    show();
    return null;
  }
  void native.then((popped) => {
    if (!popped) popInJs();
    afterPop(target, deps, show);
  });
  return null;
}

/** Runs `then` once the navigation state shows the title on top (the native pop synced), or after the bound. */
function afterPop(target: LinkState | undefined, deps: TitleLinkDeps, then: () => void) {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    unsubscribe();
    clearTimeout(timer);
    then();
  };
  const synced = () => titleLinkAction(target, deps.rootState()).type === 'stay';
  const unsubscribe = deps.onState(() => {
    if (synced()) finish();
  });
  const timer = setTimeout(finish, POP_SYNC_TIMEOUT_MS);
  if (synced()) finish();
}
