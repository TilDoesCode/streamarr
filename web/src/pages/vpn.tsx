import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Lock, Plus, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { queryKeys, useTunnelPresets, useTunnelStatus, useTunnels } from "@/api/queries";
import type { TunnelResponse } from "@/api/types";
import { errorMessage } from "@/api/client";
import { mergeTunnelStatus, tunnelState, type TunnelState } from "@/lib/tunnels";
import { TunnelCard } from "./vpn/tunnel-card";
import { TunnelDialog } from "./vpn/tunnel-dialog";
import { DeleteTunnelDialog } from "./vpn/delete-dialog";

const STATUS_POLL_MS = 5_000;

/** Built-in WireGuard tunnels: status, import/edit, and which providers and indexers use them. */
export function VpnPage() {
  const qc = useQueryClient();
  const tunnels = useTunnels();
  const status = useTunnelStatus({ refetchInterval: STATUS_POLL_MS });
  const presets = useTunnelPresets();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<TunnelResponse | null>(null);
  const [toDelete, setToDelete] = useState<TunnelResponse | null>(null);

  const merged = useMemo(
    () => mergeTunnelStatus(tunnels.data ?? [], status.data?.tunnels),
    [tunnels.data, status.data],
  );

  // A tunnel added or removed elsewhere shows up in the poll first; reload the full list then.
  const listIds = (tunnels.data ?? []).map((t) => t.id).sort().join();
  const polledIds = (status.data?.tunnels ?? []).map((t) => t.id).sort().join();
  useEffect(() => {
    if (tunnels.data && status.data && listIds !== polledIds && !tunnels.isFetching)
      void qc.invalidateQueries({ queryKey: queryKeys.tunnels, exact: true });
  }, [listIds, polledIds, tunnels.data, status.data, tunnels.isFetching, qc]);

  const presetName = (id?: string | null) =>
    presets.data?.find((preset) => preset.id === id)?.name ?? (id === "custom" || !id ? "Custom WireGuard" : id);

  return (
    <div className="space-y-4">
      <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            VPN tunnels
            {status.isFetching && !status.isLoading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
          </h2>
          <p className="text-sm text-muted-foreground">
            WireGuard tunnels Streamarr runs itself. Pick one as the connection of an indexer or provider; if it is
            not connected, that traffic stops instead of leaving directly.
          </p>
        </div>
        {merged.length > 0 && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" />
            Add tunnel
          </Button>
        )}
      </div>

      {tunnels.isLoading ? (
        <div className="grid gap-4 xl:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="h-64 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      ) : tunnels.isError ? (
        <Card>
          <CardContent className="pt-6 text-sm text-destructive">{errorMessage(tunnels.error)}</CardContent>
        </Card>
      ) : merged.length === 0 ? (
        <EmptyState onAdd={() => setCreating(true)} />
      ) : (
        <>
          <Summary tunnels={merged} />
          <ul className="grid gap-4 xl:grid-cols-2" aria-label="Tunnels">
            {merged.map((tunnel) => (
              <TunnelCard
                key={tunnel.id}
                tunnel={tunnel}
                presetName={presetName(tunnel.preset)}
                onEdit={() => setEditing(tunnel)}
                onDelete={() => setToDelete(tunnel)}
              />
            ))}
          </ul>
        </>
      )}

      {(creating || editing) && (
        <TunnelDialog
          tunnel={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}
      <DeleteTunnelDialog target={toDelete} onClose={() => setToDelete(null)} />
    </div>
  );
}

function Summary({ tunnels }: { tunnels: TunnelResponse[] }) {
  const counts = tunnels.reduce<Record<TunnelState, number>>(
    (acc, tunnel) => ({ ...acc, [tunnelState(tunnel.status.state)]: acc[tunnelState(tunnel.status.state)] + 1 }),
    { connected: 0, starting: 0, degraded: 0, down: 0, disabled: 0 },
  );
  const parts = [
    counts.connected && `${counts.connected} connected`,
    counts.starting && `${counts.starting} connecting`,
    counts.degraded && `${counts.degraded} degraded`,
    counts.down && `${counts.down} down`,
    counts.disabled && `${counts.disabled} disabled`,
  ].filter(Boolean);
  return (
    <p className="text-xs text-muted-foreground" aria-live="polite">
      {tunnels.length} tunnel{tunnels.length === 1 ? "" : "s"} · {parts.join(" · ")} · status refreshes every 5 s
    </p>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-4 px-6 py-16 text-center">
        <span className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <ShieldCheck className="size-7" />
        </span>
        <div className="max-w-md space-y-2">
          <p className="text-base font-semibold">Send indexer and Usenet traffic through your VPN</p>
          <p className="text-sm text-muted-foreground">
            Import the WireGuard configuration from Mullvad, Proton VPN or any other provider, then choose per indexer
            and provider whether it connects directly or through the tunnel. If the tunnel drops, routed traffic stops
            instead of leaking out directly.
          </p>
        </div>
        <Button size="lg" onClick={onAdd}>
          <Plus className="size-4" />
          Add tunnel
        </Button>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Lock className="size-3" />
          Runs in userspace, no root or extra container needed.
        </p>
      </CardContent>
    </Card>
  );
}
