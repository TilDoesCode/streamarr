type LinkRoute = { name: string; params?: object; state?: LinkState };
export type LinkState = { key?: string; index?: number; routes: LinkRoute[] };

/** `pop`: close `count` pages above the open title in stack `stackKey`; `stay`: it is on top already. */
export type TitleLinkAction =
  | { type: 'open' }
  | { type: 'stay'; shown: boolean }
  | { type: 'pop'; count: number; stackKey: string; screenTestID: string; shown: boolean };

// Route name -> the page's testID prefix (the native pop finds the page by it).
const TITLE_SCREENS: Record<string, string> = {
  'movie/[id]': 'movie-screen',
  'series/[id]/index': 'series-screen',
};

const idOf = (route: LinkRoute) => (route.params as { id?: unknown } | undefined)?.id;

/** The current stack the target's leaf lands in (wrappers skipped); `shown` while every level is the focused one. */
function landingStack(
  target: LinkState,
  current: LinkState,
  shown = true
): { stack: LinkState; leaf: LinkRoute; shown: boolean } | null {
  const next = target.routes[target.index ?? target.routes.length - 1];
  if (!next) return null;
  if (!next.state) return { stack: current, leaf: next, shown };
  const at = current.routes.findIndex((route) => route.name === next.name);
  const match = current.routes[at];
  const focused = at === (current.index ?? current.routes.length - 1);
  if (match?.state) return landingStack(next.state, match.state, shown && focused);
  const wrapper = current.routes.length === 1 ? current.routes[0]?.state : undefined;
  return wrapper ? landingStack(target, wrapper, shown) : null;
}

/**
 * A link to a title that is already open in the stack it lands in returns to it (pop) instead of a second copy.
 * The router would move that page to the top, which react-native-screens' native stack turns into a reset.
 */
export function titleLinkAction(
  target: LinkState | undefined,
  current: LinkState | undefined
): TitleLinkAction {
  if (!target || !current) return { type: 'open' };
  const found = landingStack(target, current);
  const prefix = found ? TITLE_SCREENS[found.leaf.name] : undefined;
  if (!found || !prefix) return { type: 'open' };
  const id = idOf(found.leaf);
  const { routes, key } = found.stack;
  const at = routes.findLastIndex((route) => route.name === found.leaf.name && idOf(route) === id);
  if (at < 0 || !key) return { type: 'open' };
  const top = found.stack.index ?? routes.length - 1;
  if (at >= top) return { type: 'stay', shown: found.shown };
  return {
    type: 'pop',
    count: top - at,
    stackKey: key,
    screenTestID: `${prefix}-${String(id)}`,
    shown: found.shown,
  };
}
