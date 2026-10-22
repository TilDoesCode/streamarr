type RailState = { key?: string; index?: number; routes: readonly RailRoute[] };
type RailRoute = { name: string; state?: RailState };

export type RailTabsState = { index: number; routes: readonly RailRoute[] };

export type RailAction =
  { type: 'POP_TO_TOP'; target: string } | { type: 'JUMP_TO'; payload: { name: string } };

export type RailSelect = {
  /** Dispatched in order: the tab shows (a hidden stack is detached), then its stack pops to its first screen. */
  actions: RailAction[];
  /** The tab was already showing: its first screen goes back to its top. */
  reselect: boolean;
};

/** The tab's own stack: expo-router can wrap it in a single-route navigator state. */
function stackOf(route: RailRoute | undefined): RailState | undefined {
  let state = route?.state;
  while (state && state.routes.length === 1 && state.routes[0]?.state)
    state = state.routes[0].state;
  return state;
}

/** TV rail: a tab always opens on its first screen; a detail left open in that tab's stack is dropped. */
export function railSelect(state: RailTabsState, name: string): RailSelect {
  const active = state.routes[state.index]?.name === name;
  const stack = stackOf(state.routes.find((route) => route.name === name));
  const actions: RailAction[] = [];
  if (!active) actions.push({ type: 'JUMP_TO', payload: { name } });
  if (stack?.key && (stack.index ?? 0) > 0) actions.push({ type: 'POP_TO_TOP', target: stack.key });
  return { actions, reselect: active };
}
