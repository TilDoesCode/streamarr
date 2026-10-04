type LinkRoute = { name: string; params?: object; state?: LinkState };
export type LinkState = { key?: string; index?: number; type?: string; routes: LinkRoute[] };

/** Where the landing stack is: `shown`, in another tab (`tab` switches to it) or `covered` by a screen above (player). */
export type LinkPlace =
  { kind: 'shown' } | { kind: 'tab'; tabsKey: string; tabName: string } | { kind: 'covered' };

/** `pop`: close `count` pages above the open title in stack `stackKey`; `stay`: it is on top already. */
export type TitleLinkAction =
  | { type: 'open' }
  | { type: 'stay'; place: LinkPlace }
  | { type: 'pop'; count: number; stackKey: string; screenTestID: string; place: LinkPlace };

// Route name -> the page's testID prefix (the native pop finds the page by it).
const TITLE_SCREENS: Record<string, string> = {
  'movie/[id]': 'movie-screen',
  'series/[id]/index': 'series-screen',
};

const idOf = (route: LinkRoute) => (route.params as { id?: unknown } | undefined)?.id;

/** The current stack the target's leaf lands in (wrappers skipped) and whether it is visible. */
function landingStack(
  target: LinkState,
  current: LinkState,
  place: LinkPlace = { kind: 'shown' }
): { stack: LinkState; leaf: LinkRoute; place: LinkPlace } | null {
  const next = target.routes[target.index ?? target.routes.length - 1];
  if (!next) return null;
  if (!next.state) return { stack: current, leaf: next, place };
  const at = current.routes.findIndex((route) => route.name === next.name);
  const match = current.routes[at];
  if (match?.state)
    return landingStack(next.state, match.state, nextPlace(place, current, at, next.name));
  const wrapper = current.routes.length === 1 ? current.routes[0]?.state : undefined;
  return wrapper ? landingStack(target, wrapper, place) : null;
}

function nextPlace(place: LinkPlace, current: LinkState, at: number, name: string): LinkPlace {
  const focused = current.index ?? current.routes.length - 1;
  if (place.kind === 'covered' || at === focused) return place;
  if (current.type === 'tab' && place.kind === 'shown' && current.key) {
    return { kind: 'tab', tabsKey: current.key, tabName: name };
  }
  return { kind: 'covered' };
}

/** A link to an open title returns to it (pop): the router's move-to-top resets react-native-screens' native stack. */
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
  if (at >= top) return { type: 'stay', place: found.place };
  return {
    type: 'pop',
    count: top - at,
    stackKey: key,
    screenTestID: `${prefix}-${String(id)}`,
    place: found.place,
  };
}

const WEB_SCHEMES = new Set(['http', 'https']);

/** The app route of an incoming link: `streamarr://movie/1`, `streamarr:///movie/1` and `/movie/1` are the same. */
export function routeFromUrl(url: string): string {
  const match = /^([a-z][\w+.-]*):(\/\/)?([^/?#]*)(.*)$/i.exec(url);
  if (!match) return url.startsWith('/') ? url : `/${url}`;
  const [, scheme = '', slashes, host = '', rest = ''] = match;
  // App schemes carry the first path segment as the host; web links carry a domain.
  const head = slashes && host && !WEB_SCHEMES.has(scheme.toLowerCase()) ? `/${host}` : '';
  const route = `${head}${rest}`;
  return route.startsWith('/') ? route : `/${route}`;
}
