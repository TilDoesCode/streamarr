import { titleLinkAction, routeFromUrl, type LinkPlace, type LinkState } from './title-link';

// A tab switch that has not reached the navigation state by then is given up (slow device): the link does nothing.
export const POP_SYNC_TIMEOUT_MS = 2000;

export type TitleLinkDeps = {
  stateFromPath(route: string): LinkState | undefined;
  rootState(): LinkState | undefined;
  dispatch(action: { type: string; payload?: object; target?: string }): void;
  onState(listener: () => void): () => void;
  /** The native pop (Apple TV), null where the stack is popped in JS. */
  popToScreen(testID: string, count: number): Promise<boolean> | null;
};

/** Incoming links: a title already open in its stack is returned to; returns the path the router still has to open. */
export function handleTitleLink(url: string, deps: TitleLinkDeps): string | null {
  const route = routeFromUrl(url);
  const target = deps.stateFromPath(route);
  const action = titleLinkAction(target, deps.rootState());
  if (action.type === 'open') return url;
  // A screen above the tabs (the player) stays until the viewer leaves it; its stack below keeps its pages.
  if (action.place.kind === 'covered') return null;
  if (action.place.kind === 'tab') {
    // A stack in a hidden tab is detached: switch first (keeps its pages), then return to the title in view.
    const { tabsKey, tabName } = action.place;
    deps.dispatch({ type: 'JUMP_TO', payload: { name: tabName }, target: tabsKey });
    whenState(
      deps,
      () => placeOf(target, deps) === 'shown',
      () => {
        if (placeOf(target, deps) === 'shown') handleTitleLink(url, deps);
      }
    );
    return null;
  }
  if (action.type === 'stay') return null;
  const native = deps.popToScreen(action.screenTestID, action.count);
  const popInJs = () =>
    deps.dispatch({ type: 'POP', payload: { count: action.count }, target: action.stackKey });
  if (!native) popInJs();
  else void native.then((popped) => popped || popInJs());
  return null;
}

function placeOf(target: LinkState | undefined, deps: TitleLinkDeps): LinkPlace['kind'] | null {
  const action = titleLinkAction(target, deps.rootState());
  return action.type === 'open' ? null : action.place.kind;
}

/** Runs `then` once `ready()` holds in the navigation state, or after the bound (slow device). */
function whenState(deps: TitleLinkDeps, ready: () => boolean, then: () => void) {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    unsubscribe();
    clearTimeout(timer);
    then();
  };
  const unsubscribe = deps.onState(() => {
    if (ready()) finish();
  });
  const timer = setTimeout(finish, POP_SYNC_TIMEOUT_MS);
  if (ready()) finish();
}
