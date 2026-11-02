import type { RouteInfo, TunnelResponse, TunnelStatus, TunnelStatusEntry } from "@/api/types";

export type TunnelState = "disabled" | "starting" | "connected" | "degraded" | "down";

const STATES: readonly TunnelState[] = ["disabled", "starting", "connected", "degraded", "down"];

/** Normalize the API's free-form state string; unknown values count as `down` (fail closed). */
export function tunnelState(state?: string | null): TunnelState {
  return STATES.includes(state as TunnelState) ? (state as TunnelState) : "down";
}

export const STATE_LABELS: Record<TunnelState, string> = {
  connected: "Connected",
  starting: "Connecting",
  degraded: "Degraded",
  down: "Down",
  disabled: "Disabled",
};

/** Overlay the polled `/tunnels/status` entries on the full tunnel list. */
export function mergeTunnelStatus(
  tunnels: TunnelResponse[],
  entries?: TunnelStatusEntry[] | null,
): TunnelResponse[] {
  if (!entries?.length) return tunnels;
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return tunnels.map((tunnel) => {
    const live = byId.get(tunnel.id);
    return live ? { ...tunnel, enabled: live.enabled, status: live.status } : tunnel;
  });
}

export interface ResolvedRoute {
  kind: "direct" | "tunnel" | "externalProxy";
  tunnelId?: string | null;
  tunnelName?: string | null;
  state?: TunnelState;
  usable: boolean;
  lastError?: string | null;
}

/** A provider's/indexer's route, refreshed with the live tunnel state when the tunnel list is loaded. */
export function resolveRoute(route?: RouteInfo | null, tunnels?: TunnelResponse[]): ResolvedRoute {
  if (!route || route.kind === "direct" || !route.kind) return { kind: "direct", usable: true };
  if (route.kind === "externalProxy") return { kind: "externalProxy", usable: true };
  const live = tunnels?.find((tunnel) => tunnel.id === route.tunnelId);
  const state = tunnelState(live ? live.status.state : route.state);
  return {
    kind: "tunnel",
    tunnelId: route.tunnelId,
    tunnelName: live?.name ?? route.tunnelName,
    state,
    usable: live ? state === "connected" : route.usable,
    lastError: live ? live.status.lastError : route.lastError,
  };
}

/** The message shown for a provider/indexer test that answered `errorCode: "vpn_down"`. */
export function vpnDownMessage(tunnelName?: string | null): string {
  return `Tunnel ${tunnelName ? `“${tunnelName}”` : "for this route"} is not connected; nothing is sent until it is.`;
}

export function isConnected(status?: TunnelStatus | null): boolean {
  return status?.state === "connected";
}
