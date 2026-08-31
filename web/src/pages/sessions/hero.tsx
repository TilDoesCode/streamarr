import { useEffect, useRef, useState, type ReactNode } from "react";
import { Activity, ArrowDownToLine, Network, Radio } from "lucide-react";
import type { EphemeralFileResponse, MetricsResponse, SessionResponse } from "@/api/types";
import { cn } from "@/lib/utils";
import { formatRate, percent, transferRateBetween, clamp } from "./model";

type ProviderConnectionMetric = NonNullable<MetricsResponse["connections"]["providers"]>[number];

export function useLiveTransferRate(totalBytes?: number | null, sampledAt = 0) {
  const previous = useRef<{ bytes: number; at: number } | null>(null);
  const [rate, setRate] = useState<number | null>(null);

  useEffect(() => {
    if (totalBytes == null || sampledAt <= 0) {
      previous.current = null;
      setRate(null);
      return;
    }

    const current = { bytes: Math.max(0, totalBytes), at: performance.now() };
    if (previous.current) setRate(transferRateBetween(previous.current, current));
    previous.current = current;
  }, [sampledAt, totalBytes]);

  return rate;
}

export function StreamsHero({
  sessions,
  files,
  metrics,
  metricsLoading,
  metricsUnavailable,
  transferRate,
  sessionsLoading,
  sessionsUnavailable,
}: {
  sessions: SessionResponse[];
  files: EphemeralFileResponse[];
  metrics?: MetricsResponse;
  metricsLoading: boolean;
  metricsUnavailable: boolean;
  transferRate: number | null;
  sessionsLoading: boolean;
  sessionsUnavailable: boolean;
}) {
  const providers = metrics?.connections.providers ?? [];
  const streamingFiles = files.filter((file) => file.isStreaming).length
    || sessions.filter((session) => session.isStreaming).length;
  const ingestRate = sessions.reduce((total, session) => total + (session.downloadBytesPerSecond ?? 0), 0);
  const anyIngest = sessions.some((session) => session.downloadBytesPerSecond != null);
  const inUse = Math.max(0, metrics?.connections.inUse ?? 0);
  const budget = Math.max(0, metrics?.connections.budget ?? 0);

  return (
    <section
      className="overflow-hidden rounded-xl border border-border/80 bg-background/75 shadow-[inset_0_1px_0_rgba(255,255,255,.08)] dark:border-white/10 dark:bg-zinc-900/75"
      aria-label="Current system load"
      aria-live="polite"
    >
      <div className="grid grid-cols-2 gap-px bg-border/80 lg:grid-cols-4 dark:bg-white/10">
        <HeroMetric
          icon={<Radio />}
          label="Streaming now"
          value={sessionsUnavailable ? "Unavailable" : sessionsLoading ? "—" : String(streamingFiles)}
          detail={sessionsUnavailable
            ? "Live stream state could not load"
            : `${sessions.length} retained ${sessions.length === 1 ? "capability" : "capabilities"}`}
          loading={sessionsLoading}
          live={!sessionsUnavailable && streamingFiles > 0}
        />
        <HeroMetric
          icon={<Activity />}
          label="Client output"
          value={metricsUnavailable ? "Unavailable" : transferRate == null ? "Measuring…" : formatRate(transferRate)}
          detail={metricsUnavailable ? "Transfer counter could not load" : "served bytes · 2 s sample"}
          loading={metricsLoading}
          live={!metricsUnavailable && !metricsLoading}
        />
        <HeroMetric
          icon={<ArrowDownToLine />}
          label="Provider ingest"
          value={sessionsUnavailable ? "Unavailable" : anyIngest ? formatRate(ingestRate) : "idle"}
          detail={sessionsUnavailable ? "Session telemetry could not load" : "article downloads · 10 s window"}
          loading={sessionsLoading}
          live={!sessionsUnavailable && ingestRate > 0}
        />
        <HeroMetric
          icon={<Network />}
          label="NNTP in use"
          value={metricsUnavailable ? "Unavailable" : metricsLoading ? "—" : `${inUse} / ${budget || "—"}`}
          detail={metricsUnavailable ? "Provider pools could not load" : "commands on the wire / global budget"}
          loading={metricsLoading}
        >
          {!metricsUnavailable && !metricsLoading && budget > 0 && (
            <CapacityBar label="Global NNTP connection pressure" percent={percent(inUse, budget)} />
          )}
        </HeroMetric>
      </div>

      <ConnectionFlow
        sessions={sessions}
        providers={providers}
        inUse={inUse}
        budget={budget}
        metricsLoading={metricsLoading}
        metricsUnavailable={metricsUnavailable}
      />
    </section>
  );
}

/**
 * Answers "where do the NNTP connections go?": consumers (each live session plus untracked
 * background work) on the left, provider pools on the right.
 */
function ConnectionFlow({
  sessions,
  providers,
  inUse,
  budget,
  metricsLoading,
  metricsUnavailable,
}: {
  sessions: SessionResponse[];
  providers: ProviderConnectionMetric[];
  inUse: number;
  budget: number;
  metricsLoading: boolean;
  metricsUnavailable: boolean;
}) {
  const consumers = [...sessions]
    .filter((session) => (session.nntpConnectionsInFlight ?? 0) > 0 || (session.downloadBytesPerSecond ?? 0) > 0)
    .sort((a, b) => (b.nntpConnectionsInFlight ?? 0) - (a.nntpConnectionsInFlight ?? 0));
  const sessionConnections = sessions.reduce((total, session) => total + Math.max(0, session.nntpConnectionsInFlight ?? 0), 0);
  const backgroundConnections = Math.max(0, inUse - sessionConnections);
  const idleBudget = Math.max(0, budget - inUse);

  return (
    <div className="grid border-t border-border/80 md:grid-cols-2 dark:border-white/10">
      <div className="min-w-0 px-4 py-3 md:border-r md:border-border/80 md:dark:border-white/10">
        <p className="mb-2.5 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground dark:text-zinc-400">
          Connections · what they work on
        </p>
        {consumers.length === 0 && backgroundConnections === 0 ? (
          <p className="text-xs text-muted-foreground">No NNTP work in flight.</p>
        ) : (
          <ul className="space-y-2">
            {consumers.map((session) => (
              <li key={session.token} className="flex items-baseline justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium" title={session.title ?? undefined}>{session.title}</p>
                  <p className="truncate font-mono text-[9px] text-muted-foreground dark:text-zinc-500">
                    {session.requestedByName || session.requestedById || session.client || "unknown requester"}
                    {session.preDownloadState === "downloading" ? " · pre-download" : ""}
                  </p>
                </div>
                <p className="shrink-0 font-mono text-xs tabular-nums">
                  {session.nntpConnectionsInFlight ?? 0} conn
                  {session.downloadBytesPerSecond != null && (
                    <span className="text-muted-foreground"> · {formatRate(session.downloadBytesPerSecond)}</span>
                  )}
                </p>
              </li>
            ))}
            {backgroundConnections > 0 && (
              <li className="flex items-baseline justify-between gap-3 text-muted-foreground">
                <p className="text-xs">Background (pre-download / repair / warmup)</p>
                <p className="shrink-0 font-mono text-xs tabular-nums">{backgroundConnections} conn</p>
              </li>
            )}
            {budget > 0 && (
              <li className="flex items-baseline justify-between gap-3 border-t border-dashed border-border/80 pt-2 text-muted-foreground dark:border-white/10">
                <p className="text-xs">Free budget</p>
                <p className="shrink-0 font-mono text-xs tabular-nums">{idleBudget} / {budget}</p>
              </li>
            )}
          </ul>
        )}
      </div>

      <div className="min-w-0 border-t border-border/80 px-4 py-3 md:border-t-0 dark:border-white/10">
        <div className="mb-2.5 flex items-center justify-between gap-3">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground dark:text-zinc-400">
            Providers · where they come from
          </p>
          <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground/70 dark:text-zinc-500">
            active / configured
          </p>
        </div>
        {metricsUnavailable ? (
          <p className="text-xs text-muted-foreground" role="status">Provider telemetry is temporarily unavailable.</p>
        ) : metricsLoading ? (
          <div className="space-y-3" aria-label="Loading provider connections">
            <span className="block h-9 animate-pulse rounded-md bg-muted dark:bg-white/5" />
            <span className="block h-9 animate-pulse rounded-md bg-muted dark:bg-white/5" />
          </div>
        ) : providers.length === 0 ? (
          <p className="text-xs text-muted-foreground">No provider pools are configured.</p>
        ) : (
          <div className="space-y-3">
            {providers.map((provider, index) => (
              <ProviderConnectionRow key={`${provider.name ?? "provider"}-${provider.priority ?? index}`} provider={provider} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function HeroMetric({
  icon,
  label,
  value,
  detail,
  loading = false,
  live = false,
  children,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
  loading?: boolean;
  live?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="min-w-0 bg-background/75 px-3 py-3.5 sm:px-4 dark:bg-zinc-900/75" role="group" aria-label={`${label}: ${value}`}>
      <div className="flex items-center gap-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground dark:text-zinc-500 [&_svg]:size-3">
        <span className={cn("text-cyan-700 dark:text-cyan-300", loading && "animate-pulse")}>{icon}</span>
        <span className="truncate">{label}</span>
        {live && <span className="size-1.5 rounded-full bg-cyan-500 motion-safe:animate-pulse" aria-hidden="true" />}
      </div>
      <p className={cn("mt-1 truncate text-lg font-semibold tabular-nums text-foreground dark:text-white", loading && "animate-pulse text-muted-foreground")} title={value}>
        {value}
      </p>
      <p className="mt-0.5 truncate text-[10px] text-muted-foreground dark:text-zinc-500" title={detail}>{detail}</p>
      {children}
    </div>
  );
}

export function ProviderConnectionRow({ provider }: { provider: ProviderConnectionMetric }) {
  const active = Math.max(0, provider.activeConnections ?? 0);
  const live = Math.max(active, provider.liveConnections ?? 0);
  const idle = Math.max(0, provider.idleConnections ?? 0);
  const capacity = active + Math.max(0, provider.availableConnections ?? 0);
  const usage = percent(active, capacity);
  const state = provider.tripped ? "failover" : active > 0 ? "transferring" : "idle";

  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <span className={cn(
          "size-1.5 shrink-0 rounded-full",
          provider.tripped ? "bg-amber-500" : active > 0 ? "bg-cyan-500 motion-safe:animate-pulse" : "bg-muted-foreground/35",
        )} />
        <p className="min-w-0 flex-1 truncate text-xs font-medium" title={provider.name ?? undefined}>
          {provider.name || "Unnamed provider"}
        </p>
        <p className="font-mono text-xs font-semibold tabular-nums">{active} / {capacity || "—"}</p>
      </div>
      <CapacityBar label={`${provider.name || "Provider"} active connections`} percent={usage} compact tripped={provider.tripped} />
      <p className="mt-1 truncate font-mono text-[9px] text-muted-foreground dark:text-zinc-500">
        {state} · {live} live socket{live === 1 ? "" : "s"} · {idle} idle
      </p>
    </div>
  );
}

export function CapacityBar({ label, percent: value, compact = false, tripped = false }: { label: string; percent: number; compact?: boolean; tripped?: boolean }) {
  const bounded = clamp(value);
  return (
    <div
      className={cn("mt-2 overflow-hidden rounded-full bg-muted dark:bg-white/10", compact ? "h-1" : "h-1.5")}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(bounded)}
    >
      <div
        className={cn("h-full origin-left rounded-full bg-cyan-500 transition-transform duration-500", tripped && "bg-amber-500")}
        style={{ transform: `scaleX(${bounded / 100})` }}
      />
    </div>
  );
}
