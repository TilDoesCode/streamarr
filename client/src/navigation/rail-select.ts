export type RailTabsState = {
  index: number;
  routes: readonly { name: string; state?: { key?: string; index?: number } }[];
};

export type RailAction =
  { type: 'POP_TO_TOP'; target: string } | { type: 'JUMP_TO'; payload: { name: string } };

export type RailSelect = {
  /** Dispatched in order: the tab's own stack pops to its first screen, then the tab shows. */
  actions: RailAction[];
  /** The tab was already showing: its first screen goes back to its top. */
  reselect: boolean;
};

/** TV rail: a tab always opens on its first screen; a detail left open in that tab's stack is dropped. */
export function railSelect(state: RailTabsState, name: string): RailSelect {
  const active = state.routes[state.index]?.name === name;
  const stack = state.routes.find((route) => route.name === name)?.state;
  const actions: RailAction[] = [];
  if (stack?.key && (stack.index ?? 0) > 0) actions.push({ type: 'POP_TO_TOP', target: stack.key });
  if (!active) actions.push({ type: 'JUMP_TO', payload: { name } });
  return { actions, reselect: active };
}
