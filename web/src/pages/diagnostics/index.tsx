import { AlertTriangle, CheckCircle2, Loader2, OctagonX, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useDiagnostics, useRefreshDiagnostics } from "@/api/queries";
import type { DiagnosticsComponent, DiagnosticsResponse } from "@/api/types";
import { errorMessage } from "@/api/client";
import { cn, formatBytes, formatMs } from "@/lib/utils";
import { errorCodeLabel, formatUptime, hintText, KIND_LABELS, VERDICT_TEXT } from "./text";
import { SpeedTestCard, useBrowserSpeedTest } from "./speed-test-card";
import { StreamingPathCard, useNow } from "./streaming-path-card";

/** Admin Diagnostics: overall verdict with explained hints, per-component checks, and a speed test. */
export function DiagnosticsPage() {
  const diagnostics = useDiagnostics();
  const refresh = useRefreshDiagnostics();
  const data = diagnostics.data;
  const now = useNow(1_000);
  const browserTest = useBrowserSpeedTest();

  const refreshAt = data ? Date.parse(data.refreshAvailableAt) : NaN;
  const waitSeconds = Number.isFinite(refreshAt) ? Math.ceil((refreshAt - now) / 1000) : 0;
  const coolingDown = waitSeconds > 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-semibold tracking-tight">Diagnostics</h2>
        {diagnostics.isFetching && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        <div className="ml-auto flex items-center gap-3">
          {data && (
            <span className="text-xs text-muted-foreground" data-testid="checked-ago">
              Checked {checkedAgo(data, now)}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending || coolingDown}
            title={coolingDown ? `Checks can run again in ${waitSeconds} s` : "Run every check again now"}
          >
            <RefreshCw className={cn(refresh.isPending && "animate-spin")} />
            {coolingDown ? `Refresh (${waitSeconds}s)` : "Refresh"}
          </Button>
        </div>
      </div>

      {(diagnostics.isError || refresh.isError) && (
        <Card role="alert" className="border-destructive/40">
          <CardContent className="flex items-center gap-2 pt-6 text-sm text-destructive">
            <AlertTriangle className="size-4 shrink-0" />
            Could not load diagnostics: {errorMessage(diagnostics.error ?? refresh.error)}
          </CardContent>
        </Card>
      )}

      {diagnostics.isLoading ? (
        <div className="h-28 w-full animate-pulse rounded-lg bg-muted" />
      ) : (
        data && <VerdictBanner data={data} />
      )}

      <StreamingPathCard browser={browserTest} />

      {data && <ComponentsCard data={data} />}

      <SpeedTestCard test={browserTest} />
    </div>
  );
}

function checkedAgo(data: DiagnosticsResponse, now: number): string {
  const checked = Date.parse(data.checkedAt);
  const age = Number.isFinite(checked) ? Math.max(0, (now - checked) / 1000) : data.ageSeconds;
  const seconds = Math.round(age);
  if (seconds < 90) return `${seconds} s ago`;
  return `${Math.round(seconds / 60)} min ago`;
}

const TONE = {
  ok: {
    box: "border-success/30 bg-success/10",
    icon: <CheckCircle2 className="size-6 text-success" />,
    text: "text-success-foreground",
  },
  degraded: {
    box: "border-amber-500/30 bg-amber-500/10",
    icon: <AlertTriangle className="size-6 text-amber-600 dark:text-amber-400" />,
    text: "text-amber-900 dark:text-amber-200",
  },
  down: {
    box: "border-destructive/40 bg-destructive/10",
    icon: <OctagonX className="size-6 text-destructive" />,
    text: "text-destructive",
  },
} as const;

function toneOf(status?: string | null): keyof typeof TONE {
  return status === "ok" || status === "degraded" || status === "down" ? status : "degraded";
}

function VerdictBanner({ data }: { data: DiagnosticsResponse }) {
  const tone = TONE[toneOf(data.status)];
  const verdict = VERDICT_TEXT[data.status ?? ""] ?? VERDICT_TEXT.degraded;
  const hints = data.hints ?? [];

  return (
    <section className={cn("rounded-lg border p-5", tone.box)} aria-label="Overall status" data-status={data.status}>
      <div className="flex flex-wrap items-start gap-4">
        <span className="mt-0.5 shrink-0">{tone.icon}</span>
        <div className="min-w-0 flex-1 space-y-1">
          <p className={cn("text-lg font-semibold", tone.text)}>{verdict.title}</p>
          <p className="text-sm text-muted-foreground">{verdict.body}</p>
        </div>
        <dl className="grid shrink-0 grid-cols-[auto_auto] gap-x-4 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Version</dt>
          <dd className="font-medium tabular-nums" title={data.server.version ?? undefined}>
            {data.server.version ? `v${data.server.version.split("+")[0]}` : "—"}
          </dd>
          <dt className="text-muted-foreground">Uptime</dt>
          <dd className="font-medium tabular-nums">{formatUptime(data.server.uptimeSeconds)}</dd>
        </dl>
      </div>
      {hints.length > 0 && (
        <ul className="mt-4 space-y-2 border-t border-current/10 pt-4" aria-label="What to check">
          {hints.map((code) => {
            const text = hintText(code);
            return (
              <li key={code} className="flex gap-2 text-sm">
                <AlertTriangle className={cn("mt-0.5 size-4 shrink-0", tone.text)} aria-hidden />
                <span>
                  <span className="font-medium">{text.title}</span>{" "}
                  <span className="text-muted-foreground">{text.action}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const STATUS_DOT: Record<string, string> = {
  ok: "bg-success",
  degraded: "bg-amber-500",
  down: "bg-destructive",
  unconfigured: "bg-muted-foreground/50",
};

function StatusBadge({ status }: { status?: string | null }) {
  const s = status ?? "unknown";
  const variant = s === "ok" ? "success" : s === "down" ? "destructive" : "muted";
  return (
    <Badge
      variant={variant}
      className={cn(
        "gap-1.5 capitalize",
        s === "degraded" && "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300",
      )}
    >
      <span className={cn("size-1.5 rounded-full", STATUS_DOT[s] ?? "bg-muted-foreground/50")} aria-hidden />
      {s}
    </Badge>
  );
}

function ComponentsCard({ data }: { data: DiagnosticsResponse }) {
  const components = data.components ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Components</CardTitle>
        <CardDescription>
          Dependency probes are cached briefly and shared with the dashboard; database, disk and stream checks
          are live.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0 pb-2">
        {components.length === 0 ? (
          <p className="px-6 pb-4 text-sm text-muted-foreground">No components were reported.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-y bg-muted/30 text-left text-xs uppercase text-muted-foreground">
                  <th className="px-6 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Component</th>
                  <th className="px-3 py-2 text-right font-medium">Latency</th>
                  <th className="px-3 py-2 font-medium">Problem</th>
                  <th className="px-6 py-2 font-medium">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {components.map((component, index) => (
                  <ComponentRow key={component.id ?? index} component={component} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ComponentRow({ component }: { component: DiagnosticsComponent }) {
  const code = errorCodeLabel(component.errorCode);
  return (
    <tr className="align-top" data-testid={`component-${component.id}`}>
      <td className="px-6 py-3">
        <StatusBadge status={component.status} />
      </td>
      <td className="px-3 py-3">
        <div className="font-medium">{component.name ?? component.id}</div>
        <div className="text-xs text-muted-foreground">{KIND_LABELS[component.kind ?? ""] ?? component.kind}</div>
      </td>
      <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">
        {component.latencyMs != null ? formatMs(component.latencyMs) : "—"}
      </td>
      <td className="max-w-[22rem] px-3 py-3">
        {code ? (
          <div className="space-y-0.5">
            <div
              className={cn(
                "font-medium",
                component.status === "down" ? "text-destructive" : "text-amber-700 dark:text-amber-300",
              )}
            >
              {code}
            </div>
            {component.error && (
              <div className="break-words font-mono text-xs text-muted-foreground">{component.error}</div>
            )}
          </div>
        ) : component.error ? (
          <div className="break-words font-mono text-xs text-muted-foreground">{component.error}</div>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-6 py-3">
        <ComponentDetails component={component} />
      </td>
    </tr>
  );
}

function ComponentDetails({ component }: { component: DiagnosticsComponent }) {
  const parts: React.ReactNode[] = [];
  if (component.detail) parts.push(<div key="detail">{component.detail}</div>);
  if (component.freeBytes != null) {
    parts.push(
      <div key="disk">
        {formatBytes(component.freeBytes)} free
        {component.minimumFreeBytes != null && ` · minimum ${formatBytes(component.minimumFreeBytes)}`}
      </div>,
    );
  }
  if (component.activeStreams != null) {
    parts.push(
      <div key="streams">
        {component.activeStreams} active stream{component.activeStreams === 1 ? "" : "s"}
      </div>,
    );
  }
  if (component.connectionsInUse != null && component.connectionsMax != null && component.connectionsMax > 0) {
    const ratio = Math.min(1, component.connectionsInUse / component.connectionsMax);
    parts.push(
      <div key="pool" className="space-y-1">
        <div>
          {component.connectionsInUse} / {component.connectionsMax} connections in use
        </div>
        <div className="h-1.5 w-32 overflow-hidden rounded-full bg-muted" aria-hidden>
          <div
            className={cn("h-full rounded-full", ratio >= 1 ? "bg-destructive" : "bg-primary")}
            style={{ width: `${Math.max(2, ratio * 100)}%` }}
          />
        </div>
      </div>,
    );
  }
  if (parts.length === 0) return <span className="text-muted-foreground">—</span>;
  return <div className="space-y-1 text-xs text-muted-foreground">{parts}</div>;
}
