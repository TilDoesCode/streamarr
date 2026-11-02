import { useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Database,
  Loader2,
  Pencil,
  Server,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Trash2,
  XCircle,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { TunnelStatePill, STATE_TEXT } from "@/components/tunnel-state";
import { useTestTunnel, useUpdateTunnel } from "@/api/queries";
import type { TunnelResponse, TunnelTestResult } from "@/api/types";
import { errorMessage } from "@/api/client";
import { cn, formatBytes, formatMs, timeAgo } from "@/lib/utils";
import { tunnelState } from "@/lib/tunnels";
import { writeFromTunnel } from "./form";
import { CopyableKey } from "./copyable-key";

export function TunnelCard({
  tunnel,
  presetName,
  onEdit,
  onDelete,
}: {
  tunnel: TunnelResponse;
  presetName: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const update = useUpdateTunnel();
  const test = useTestTunnel();
  const [result, setResult] = useState<TunnelTestResult | null>(null);
  const state = tunnelState(tunnel.status.state);
  const providers = tunnel.usedBy.providers ?? [];
  const indexers = tunnel.usedBy.indexers ?? [];
  const StateIcon = state === "connected" ? ShieldCheck : state === "disabled" ? ShieldOff : ShieldAlert;

  async function toggleEnabled(enabled: boolean) {
    try {
      await update.mutateAsync({ id: tunnel.id!, body: { ...writeFromTunnel(tunnel), enabled } });
      toast.success(`${tunnel.name} ${enabled ? "enabled" : "disabled"}.`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function runTest() {
    setResult(null);
    try {
      const res = await test.mutateAsync(tunnel.id!);
      setResult(res);
      if (res.success) toast.success(`${tunnel.name}: handshake OK${res.exitIp ? `, exit IP ${res.exitIp}` : ""}.`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <li
      className="flex flex-col rounded-xl border bg-card shadow-sm"
      data-testid={`tunnel-${tunnel.id}`}
      aria-label={tunnel.name ?? undefined}
    >
      <div className="flex items-start gap-3 p-4">
        <span
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted",
            STATE_TEXT[state],
            state === "connected" && "bg-emerald-500/10",
          )}
        >
          <StateIcon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="truncate text-base font-semibold">{tunnel.name}</h3>
            <TunnelStatePill state={state} />
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {presetName} · <span className="font-mono">{tunnel.endpoint}</span>
          </p>
        </div>
      </div>

      <StatusLine tunnel={tunnel} />

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-4 py-3 text-xs sm:grid-cols-3">
        <Detail label="Address">
          <span className="font-mono">{(tunnel.addresses ?? []).join(", ") || "—"}</span>
        </Detail>
        <Detail label="DNS">
          <span className="font-mono">{(tunnel.dns ?? []).join(", ") || "—"}</span>
        </Detail>
        <Detail label="Traffic">
          <span className="inline-flex items-center gap-2 tabular-nums">
            <span className="inline-flex items-center gap-0.5" title="Received">
              <ArrowDown className="size-3 text-muted-foreground" />
              {formatBytes(tunnel.status.rxBytes ?? 0)}
            </span>
            <span className="inline-flex items-center gap-0.5" title="Sent">
              <ArrowUp className="size-3 text-muted-foreground" />
              {formatBytes(tunnel.status.txBytes ?? 0)}
            </span>
          </span>
        </Detail>
        {tunnel.publicKey && (
          <div className="col-span-2 min-w-0 sm:col-span-3">
            <dt className="mb-1 text-muted-foreground">This device's public key</dt>
            <dd>
              <CopyableKey value={tunnel.publicKey} />
            </dd>
          </div>
        )}
      </dl>

      <div className="flex flex-wrap items-center gap-1.5 border-t px-4 py-2.5 text-xs">
        <span className="mr-1 text-muted-foreground">Used by</span>
        {providers.length === 0 && indexers.length === 0 ? (
          <span className="text-muted-foreground">nothing yet. Pick it as the connection of an indexer or provider.</span>
        ) : (
          <>
            {indexers.length > 0 && (
              <UsageChip icon={<Database className="size-3" />} count={indexers.length} noun="indexer" names={indexers.map((i) => i.name ?? "")} />
            )}
            {providers.length > 0 && (
              <UsageChip icon={<Server className="size-3" />} count={providers.length} noun="provider" names={providers.map((p) => p.name ?? "")} />
            )}
          </>
        )}
      </div>

      <div className="mt-auto flex flex-wrap items-center justify-end gap-1 border-t px-3 py-2">
        <div className="mr-auto flex items-center gap-2 pl-1">
          <Switch
            checked={tunnel.enabled}
            onCheckedChange={toggleEnabled}
            disabled={update.isPending}
            aria-label={`${tunnel.enabled ? "Disable" : "Enable"} ${tunnel.name}`}
          />
          <span className="text-xs text-muted-foreground">{tunnel.enabled ? "Enabled" : "Disabled"}</span>
        </div>
        <Button variant="outline" size="sm" onClick={runTest} disabled={test.isPending} aria-label={`Test ${tunnel.name}`}>
          {test.isPending ? <Loader2 className="size-4 animate-spin" /> : <Zap className="size-4" />}
          Test
        </Button>
        <Button variant="ghost" size="icon" aria-label={`Edit ${tunnel.name}`} onClick={onEdit}>
          <Pencil className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" aria-label={`Delete ${tunnel.name}`} onClick={onDelete}>
          <Trash2 className="size-4 text-destructive" />
        </Button>
      </div>

      {result && <TestResult result={result} />}
    </li>
  );
}

function StatusLine({ tunnel }: { tunnel: TunnelResponse }) {
  const status = tunnel.status;
  const state = tunnelState(status.state);
  const since = status.since ? timeAgo(status.since) : null;

  if (state === "connected")
    return (
      <div className="mx-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-emerald-500/5 px-3 py-2 text-xs">
        <Metric label="Exit IP" value={status.exitIp ?? "—"} mono />
        <Metric label="Latency" value={status.latencyMs != null ? formatMs(status.latencyMs) : "—"} />
        <Metric label="Handshake" value={status.lastHandshakeUtc ? timeAgo(status.lastHandshakeUtc) : "—"} />
      </div>
    );

  const text =
    state === "disabled"
      ? "Switched off. Anything routed through it fails with “VPN down” until you enable it."
      : state === "starting"
        ? "Bringing the tunnel up and waiting for the first handshake…"
        : status.lastError ?? (state === "degraded" ? "Handshakes are late; traffic may stall." : "Not connected.");

  return (
    <div
      className={cn(
        "mx-4 flex items-start justify-between gap-3 rounded-lg px-3 py-2 text-xs",
        state === "down" && "bg-rose-500/5",
        state === "degraded" && "bg-amber-500/5",
        state === "starting" && "bg-sky-500/5",
        state === "disabled" && "bg-muted/50",
      )}
    >
      <span className={cn("min-w-0 break-words", state === "disabled" ? "text-muted-foreground" : STATE_TEXT[state])}>{text}</span>
      {since && state !== "disabled" && <span className="shrink-0 text-muted-foreground">since {since}</span>}
    </div>
  );
}

function Metric({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-medium tabular-nums", mono && "font-mono")}>{value}</span>
    </span>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate">{children}</dd>
    </div>
  );
}

function UsageChip({ icon, count, noun, names }: { icon: React.ReactNode; count: number; noun: string; names: string[] }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 font-medium"
      title={names.join(", ")}
    >
      {icon}
      {count} {noun}
      {count === 1 ? "" : "s"}
    </span>
  );
}

function TestResult({ result }: { result: TunnelTestResult }) {
  return (
    <div role="status" className="border-t px-4 py-2.5 text-xs">
      {result.success ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="inline-flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="size-3.5" /> Handshake OK
          </span>
          {result.exitIp && <Metric label="Exit IP" value={result.exitIp} mono />}
          {result.latencyMs != null && <Metric label="Latency" value={formatMs(result.latencyMs)} />}
          {result.lastHandshakeUtc && <Metric label="Handshake" value={timeAgo(result.lastHandshakeUtc)} />}
        </div>
      ) : (
        <span className="inline-flex items-start gap-1.5 text-rose-600 dark:text-rose-400">
          <XCircle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Test failed{result.handshakeOk ? " after the handshake" : ", no handshake"}: {result.error ?? "the tunnel is not connected"}
          </span>
        </span>
      )}
    </div>
  );
}
