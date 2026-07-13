import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Database,
  Gauge,
  Loader2,
  Radio,
  Server,
  XCircle,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { HealthBadge } from "@/components/resolve-outcome";
import { useGeneralConfig, useHealth, useSessions } from "@/api/queries";
import type { ReachabilityStatus, SessionResponse } from "@/api/types";
import { errorMessage } from "@/api/client";
import { cn, formatBytes, formatMs, timeAgo } from "@/lib/utils";

/**
 * Operator dashboard (BRIEF §9.1.1): service health, per-indexer/per-provider reachability,
 * live session count, NNTP connections vs the configured budget, a live throughput chart, and
 * recent resolves with their health outcomes. All polled — no SSE dependency.
 */
export function DashboardPage() {
  const health = useHealth({ deep: true, refetchInterval: 20_000 });
  const sessions = useSessions({ refetchInterval: 2_000 });
  const general = useGeneralConfig();

  const live = sessions.data ?? [];
  const budget = general.data?.connectionBudget ?? 0;
  const connsInUse = live.reduce((n, s) => n + (s.nntpConnectionsInFlight ?? 0), 0);
  const series = useThroughputSeries(live);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <h2 className="text-xl font-semibold tracking-tight">Dashboard</h2>
        {(health.isFetching || sessions.isFetching) && (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        )}
      </div>

      {/* stat row */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          icon={<Activity className="size-4" />}
          label="Service"
          value={health.data?.status ?? (health.isLoading ? "…" : "unknown")}
          detail={health.data?.version ? `v${health.data.version}` : undefined}
          tone={statusTone(health.data?.status)}
        />
        <Stat
          icon={<Radio className="size-4" />}
          label="Live sessions"
          value={String(live.length)}
          detail={`${formatBytes(live.reduce((n, s) => n + (s.bytesServed ?? 0), 0))} served`}
        />
        <Stat
          icon={<Gauge className="size-4" />}
          label="NNTP connections"
          value={budget ? `${connsInUse} / ${budget}` : String(connsInUse)}
          detail={budget ? "in use vs budget" : "in use"}
          tone={budget && connsInUse >= budget ? "warn" : "default"}
        >
          {budget > 0 && (
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  connsInUse >= budget ? "bg-destructive" : "bg-primary",
                )}
                style={{ width: `${Math.min(100, budget ? (connsInUse / budget) * 100 : 0)}%` }}
              />
            </div>
          )}
        </Stat>
        <Stat
          icon={<Server className="size-4" />}
          label="Reachability"
          value={`${reachableCount(health.data?.indexers)}·${reachableCount(health.data?.providers)}`}
          detail="indexers · providers up"
        />
      </div>

      {health.isError && (
        <Card>
          <CardContent className="flex items-center gap-2 pt-6 text-sm text-destructive">
            <AlertTriangle className="size-4" />
            {errorMessage(health.error)}
          </CardContent>
        </Card>
      )}

      {/* throughput */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="size-4" />
            Stream throughput
          </CardTitle>
          <CardDescription>
            Live aggregate bytes served across all sessions, sampled every 2s (MB/s).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                <defs>
                  <linearGradient id="tp" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" />
                <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" width={48} />
                <Tooltip
                  contentStyle={{
                    background: "hsl(var(--popover, var(--card)))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  formatter={(v: number) => [`${v.toFixed(2)} MB/s`, "Throughput"]}
                />
                <Area
                  type="monotone"
                  dataKey="mbps"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  fill="url(#tp)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* health cards */}
      <div className="grid gap-4 lg:grid-cols-2">
        <ReachabilityCard
          title="Indexers"
          icon={<Database className="size-4" />}
          items={health.data?.indexers}
          loading={health.isLoading}
          empty="No indexers configured yet."
        />
        <ReachabilityCard
          title="Usenet providers"
          icon={<Server className="size-4" />}
          items={health.data?.providers}
          loading={health.isLoading}
          empty="No providers configured yet."
        />
      </div>

      <RecentResolves sessions={live} loading={sessions.isLoading} />
    </div>
  );
}

// --- live throughput sampling ----------------------------------------------------------
// There is no server throughput endpoint (by design — /stream is a generic byte source), so
// the dashboard derives a live rate from the delta of total bytes-served between session
// polls. A closed session drops out of the sum, so deltas are clamped at zero.
function useThroughputSeries(sessions: SessionResponse[]) {
  const [series, setSeries] = useState<{ label: string; mbps: number }[]>([]);
  const last = useRef<{ t: number; bytes: number } | null>(null);
  const tick = useRef(0);

  const totalBytes = sessions.reduce((n, s) => n + (s.bytesServed ?? 0), 0);

  useEffect(() => {
    const now = performance.now();
    if (last.current) {
      const dt = (now - last.current.t) / 1000;
      const db = totalBytes - last.current.bytes;
      if (dt > 0.25) {
        const mbps = Math.max(0, db) / dt / (1024 * 1024);
        tick.current += 1;
        setSeries((s) => [...s.slice(-39), { label: String(tick.current), mbps: Number(mbps.toFixed(3)) }]);
        last.current = { t: now, bytes: totalBytes };
      }
    } else {
      last.current = { t: now, bytes: totalBytes };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalBytes]);

  return series;
}

function reachableCount(items?: ReachabilityStatus[] | null): string {
  if (!items || items.length === 0) return "0/0";
  return `${items.filter((i) => i.reachable).length}/${items.length}`;
}

function statusTone(status?: string | null): "default" | "success" | "warn" {
  const s = (status ?? "").toLowerCase();
  if (s === "ok" || s === "healthy") return "success";
  if (s === "degraded") return "warn";
  return "default";
}

function Stat({
  icon,
  label,
  value,
  detail,
  tone = "default",
  children,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail?: string;
  tone?: "default" | "success" | "warn";
  children?: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center gap-2 text-xs font-medium uppercase text-muted-foreground">
          {icon}
          {label}
        </div>
        <div
          className={cn(
            "mt-1 text-2xl font-semibold capitalize tabular-nums",
            tone === "success" && "text-emerald-600 dark:text-emerald-400",
            tone === "warn" && "text-amber-600 dark:text-amber-400",
          )}
        >
          {value}
        </div>
        {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
        {children}
      </CardContent>
    </Card>
  );
}

function ReachabilityCard({
  title,
  icon,
  items,
  loading,
  empty,
}: {
  title: string;
  icon: React.ReactNode;
  items?: ReachabilityStatus[] | null;
  loading: boolean;
  empty: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {icon}
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="h-16 w-full animate-pulse rounded-md bg-muted" />
        ) : !items || items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : (
          <ul className="space-y-2">
            {items.map((item) => (
              <li
                key={item.name}
                className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
              >
                <span className="flex min-w-0 items-center gap-2">
                  {item.reachable ? (
                    <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
                  ) : (
                    <XCircle className="size-4 shrink-0 text-destructive" />
                  )}
                  <span className="truncate font-medium">{item.name}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                  {item.reachable ? (
                    item.latencyMs != null && <span className="tabular-nums">{formatMs(item.latencyMs)}</span>
                  ) : (
                    <span className="max-w-[16rem] truncate text-destructive" title={item.error ?? undefined}>
                      {item.error ?? "unreachable"}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function RecentResolves({ sessions, loading }: { sessions: SessionResponse[]; loading: boolean }) {
  // Each open session began with a resolve; the newest are the most recent resolves, with the
  // session state standing in for the resolve health outcome (BRIEF §9.1.1).
  const recent = useMemo(
    () =>
      [...sessions]
        .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())
        .slice(0, 8),
    [sessions],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Recent resolves</CardTitle>
        <CardDescription>Most recently opened sessions with their health outcome.</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="h-16 w-full animate-pulse rounded-md bg-muted" />
        ) : recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No recent resolves. Resolve a release from the Search / Debug playground.
          </p>
        ) : (
          <ul className="divide-y">
            {recent.map((s) => (
              <li key={s.token} className="flex items-center gap-3 py-2 text-sm">
                <HealthBadge status={s.state} />
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={s.releaseId ?? ""}>
                  {s.releaseId}
                </span>
                <Badge variant="muted">{s.client ?? "unknown"}</Badge>
                <span className="shrink-0 tabular-nums text-muted-foreground">{formatBytes(s.bytesServed)}</span>
                <span className="w-16 shrink-0 text-right text-xs text-muted-foreground">
                  {timeAgo(s.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
