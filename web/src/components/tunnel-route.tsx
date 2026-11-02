import { Link } from "@tanstack/react-router";
import { Globe, Network, ShieldAlert, ShieldCheck } from "lucide-react";
import { Label } from "@/components/ui/label";
import type { RouteInfo, TunnelResponse } from "@/api/types";
import { cn } from "@/lib/utils";
import { resolveRoute, STATE_LABELS, tunnelState, vpnDownMessage } from "@/lib/tunnels";

const badgeBase = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium";

/** How a provider's/indexer's connections leave the server: Direct, via a tunnel, or the legacy external proxy. */
export function RouteBadge({ route, tunnels }: { route?: RouteInfo | null; tunnels?: TunnelResponse[] }) {
  const resolved = resolveRoute(route, tunnels);
  if (resolved.kind === "direct")
    return (
      <span className={cn(badgeBase, "border-border text-muted-foreground")} title="Connects directly, without a VPN">
        <Globe className="size-3" />
        Direct
      </span>
    );
  if (resolved.kind === "externalProxy")
    return (
      <span className={cn(badgeBase, "border-border text-foreground")} title="Uses the legacy INDEXER_PROXY setting">
        <Network className="size-3" />
        External proxy
      </span>
    );
  if (resolved.usable)
    return (
      <span
        className={cn(badgeBase, "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300")}
        title={`Routed through the VPN tunnel “${resolved.tunnelName}”`}
      >
        <ShieldCheck className="size-3" />
        via {resolved.tunnelName}
      </span>
    );
  return (
    <span
      className={cn(badgeBase, "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300")}
      title={`${resolved.tunnelName}: ${resolved.lastError ?? STATE_LABELS[resolved.state ?? "down"]}. Nothing is sent until the tunnel is connected.`}
    >
      <ShieldAlert className="size-3" />
      via {resolved.tunnelName} · VPN down
    </span>
  );
}

/** "Connection" select for the provider/indexer dialogs; `""` means direct. */
export function ConnectionSelect({
  id,
  value,
  onChange,
  tunnels,
  hint,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  tunnels?: TunnelResponse[];
  hint: string;
}) {
  const list = tunnels ?? [];
  const missing = value !== "" && !list.some((tunnel) => tunnel.id === value);
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Connection</Label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <option value="">Direct (default)</option>
        {list.map((tunnel) => (
          <option key={tunnel.id} value={tunnel.id ?? ""}>
            via {tunnel.name} – {STATE_LABELS[tunnelState(tunnel.status.state)].toLowerCase()}
          </option>
        ))}
        {missing && <option value={value}>via the current tunnel</option>}
      </select>
      {list.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No VPN tunnels yet.{" "}
          <Link to="/vpn" className="font-medium text-primary hover:underline">
            Add a VPN tunnel first
          </Link>
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

/** Inline result for a Test that answered `errorCode: "vpn_down"`: calm, specific, and a way to fix it. */
export function VpnDownNotice({ tunnelName }: { tunnelName?: string | null }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1 text-rose-600 dark:text-rose-400">
      <ShieldAlert className="size-3.5 shrink-0" />
      <span>{vpnDownMessage(tunnelName)}</span>
      <Link to="/vpn" className="font-medium text-primary hover:underline">
        Open VPN
      </Link>
    </span>
  );
}
