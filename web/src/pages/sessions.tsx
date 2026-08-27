import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Clock3,
  Download,
  Grid2X2,
  HardDrive,
  History,
  Loader2,
  MonitorPlay,
  Network,
  Radio,
  Search,
  Table2,
  Trash2,
  UserRound,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import {
  useCloseSession,
  useEphemeralFiles,
  useGeneralConfig,
  useMetrics,
  usePurgeEphemeralFile,
  useSessions,
  useStreamingHistory,
  useStreamRecords,
} from "@/api/queries";
import type {
  EphemeralFileResponse,
  MetricsResponse,
  SessionResponse,
  StreamingHistoryResponse,
  StreamRecordSummaryResponse,
} from "@/api/types";
import { errorMessage } from "@/api/client";
import { EmptyOpsState, OpsHero } from "@/components/ops-page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn, formatBytes, formatTicks, timeAgo } from "@/lib/utils";

type ViewMode = "cards" | "table";
type StatusFilter = "all" | "live" | "failed" | "completed";
type SessionWithTitle = SessionResponse & { title?: string | null };
type EventWithTitle = StreamingHistoryResponse & { title?: string | null };
type RecordWithOutcome = StreamRecordSummaryResponse & {
  resolvedReleaseId?: string | null;
  resolvedTitle?: string | null;
  failureKind?: string | null;
  failureReason?: string | null;
};

interface PlaybackVisit {
  key: string;
  sessionToken?: string;
  releaseId?: string;
  workId?: string;
  title?: string;
  source?: string;
  userId?: string;
  userName?: string;
  device?: string;
  startedAt?: string;
  updatedAt?: string;
  positionTicks: number;
  durationTicks: number;
  state: string;
  eventCount: number;
}

interface StreamAttempt {
  key: string;
  token?: string;
  workId?: string;
  title: string;
  releaseId?: string;
  fileName?: string;
  container?: string;
  requestedTitle?: string;
  requestedReleaseId?: string;
  state: string;
  isLive: boolean;
  isFailed: boolean;
  isCompleted: boolean;
  failureKind?: string;
  failureReason?: string;
  requester: string;
  source: string;
  device?: string;
  createdAt?: string;
  bytesServed: number;
  sizeBytes: number;
  payloadPercent: number;
  chunkPercent?: number;
  chunksQueried?: number;
  totalChunks?: number;
  diskPercent?: number;
  diskState?: string;
  retentionPriority?: string;
  storageBytes?: number;
  cachedChunks?: number;
  purgeAt?: string;
  playbackPositionTicks?: number;
  playbackDurationTicks?: number;
  visits: PlaybackVisit[];
  live?: SessionWithTitle;
  file?: EphemeralFileResponse;
  record?: RecordWithOutcome;
}

interface WorkGroup {
  key: string;
  workId?: string;
  title: string;
  attempts: StreamAttempt[];
  unmatchedVisits: PlaybackVisit[];
  updatedAt: number;
}

interface AttemptSeed {
  key: string;
  token?: string;
  live?: SessionWithTitle;
  file?: EphemeralFileResponse;
  record?: RecordWithOutcome;
  visits: PlaybackVisit[];
}

const FAILURE_STATES = new Set(["dead", "error", "failed", "invalidated"]);
const COMPLETED_STATES = new Set(["closed", "expired", "evicted", "purged", "reused"]);

export function SessionsPage() {
  const sessions = useSessions();
  const files = useEphemeralFiles();
  const metrics = useMetrics({ refetchInterval: 2_000 });
  const config = useGeneralConfig();
  const records = useStreamRecords(200, { refetchInterval: 5_000 });
  const events = useStreamingHistory(400, { refetchInterval: 5_000 });
  const [viewMode, setViewMode] = useState<ViewMode>("cards");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [filter, setFilter] = useState("");
  const groups = useMemo(
    () => buildWorkGroups(
      (sessions.data ?? []) as SessionWithTitle[],
      files.data ?? [],
      (records.data ?? []) as RecordWithOutcome[],
      (events.data ?? []) as EventWithTitle[],
    ),
    [events.data, files.data, records.data, sessions.data],
  );
  const visible = useMemo(() => filterGroups(groups, filter, status), [filter, groups, status]);
  const cacheBudgetBytes = Math.max(0, (config.data?.ephemeralCacheSizeMb ?? 0) * 1024 * 1024);
  const cacheAllocatedBytes = (files.data ?? []).reduce((total, file) => total + Math.max(0, file.sizeBytes ?? 0), 0);
  const streamingFiles = (files.data ?? []).filter((file) => file.isStreaming).length;
  const transferRate = useLiveTransferRate(metrics.data?.bytesServedTotal, metrics.dataUpdatedAt);
  const sources: Array<{ label: string; query: { isError: boolean; error: unknown; data?: unknown } }> = [
    { label: "Live sessions", query: sessions },
    { label: "Ephemeral files", query: files },
    { label: "Stream attempts", query: records },
    { label: "Playback events", query: events },
    { label: "System load", query: metrics },
    { label: "Cache configuration", query: config },
  ];
  const errors = sources.filter(({ query }) => query.isError);
  const loading = [sessions, files, records, events].every((query) => query.isLoading && query.data == null);
  const fetching = [sessions, files, records, events, metrics, config].some((query) => query.isFetching);

  return (
    <div className="space-y-5">
      <OpsHero
        eyebrow="Unified stream ledger"
        title="Streams"
        description="Every live capability, retained file, resolve attempt, and playback visit is grouped by work so retries across different release versions stay visible together."
        accent="cyan"
      >
        <StreamCapacityOverview
          allocatedBytes={cacheAllocatedBytes}
          budgetBytes={cacheBudgetBytes}
          cacheEntries={files.data?.length ?? 0}
          cacheLoading={files.isLoading || config.isLoading}
          cacheUnavailable={files.isError || config.isError}
          transferRate={transferRate}
          streamingFiles={streamingFiles}
          retainedSessions={sessions.data?.length ?? 0}
          streamingLoading={files.isLoading || sessions.isLoading}
          streamingUnavailable={files.isError || sessions.isError}
          metrics={metrics.data}
          metricsLoading={metrics.isLoading}
          metricsUnavailable={metrics.isError}
        />
      </OpsHero>

      <div className="grid gap-3 rounded-xl border bg-card p-3 lg:grid-cols-[minmax(16rem,1fr)_11rem_auto]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter release, work, requester or device…"
            className="pl-9"
            aria-label="Filter streams"
          />
        </div>
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value as StatusFilter)}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          aria-label="Filter stream status"
        >
          <option value="all">All outcomes</option>
          <option value="live">Live</option>
          <option value="failed">Failed</option>
          <option value="completed">Completed</option>
        </select>
        <div className="flex items-center justify-between gap-2 lg:justify-end">
          <span className="font-mono text-[10px] text-muted-foreground">
            {visible.reduce((count, group) => count + group.attempts.length + group.unmatchedVisits.length, 0)} rows
          </span>
          <div className="flex rounded-lg border bg-muted/40 p-1" role="group" aria-label="Stream display mode">
            <ViewButton active={viewMode === "cards"} onClick={() => setViewMode("cards")} label="Cards" icon={<Grid2X2 />} />
            <ViewButton active={viewMode === "table"} onClick={() => setViewMode("table")} label="Table" icon={<Table2 />} />
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground" aria-live="polite">
        <span className={cn("size-2 rounded-full", fetching ? "animate-pulse bg-cyan-500" : "bg-muted-foreground/40")} />
        {fetching ? "Refreshing stream ledger" : "Live sources refresh automatically"}
      </div>

      {errors.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200" role="status">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div>
              <p className="font-medium">Some stream data could not refresh</p>
              <ul className="mt-1 space-y-0.5 text-xs">
                {errors.map(({ label, query }) => <li key={label}>{label}: {errorMessage(query.error)}</li>)}
              </ul>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="space-y-3" aria-label="Loading streams">
          {[0, 1, 2].map((key) => <div key={key} className="h-44 animate-pulse rounded-2xl bg-muted" />)}
        </div>
      ) : groups.length === 0 ? (
        <EmptyOpsState icon={<Radio className="size-5" />} title="No streams yet" description="Resolve and play a release. Its attempts, cache state, and playback visits will appear here." />
      ) : visible.length === 0 ? (
        <EmptyOpsState icon={<Search className="size-5" />} title="No streams match" description="Try a broader search or a different outcome filter." />
      ) : viewMode === "cards" ? (
        <StreamsCards groups={visible} />
      ) : (
        <StreamsTable groups={visible} />
      )}
    </div>
  );
}

type ProviderConnectionMetric = NonNullable<MetricsResponse["connections"]["providers"]>[number];

interface TransferCounterSample {
  bytes: number;
  at: number;
}

export function transferRateBetween(previous: TransferCounterSample, current: TransferCounterSample): number | null {
  const elapsedMilliseconds = current.at - previous.at;
  const byteDelta = current.bytes - previous.bytes;
  if (elapsedMilliseconds <= 0 || elapsedMilliseconds > 15_000 || byteDelta < 0) return null;
  return byteDelta / (elapsedMilliseconds / 1_000);
}

function useLiveTransferRate(totalBytes?: number | null, sampledAt = 0) {
  const previous = useRef<TransferCounterSample | null>(null);
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

function StreamCapacityOverview({
  allocatedBytes,
  budgetBytes,
  cacheEntries,
  cacheLoading,
  cacheUnavailable,
  transferRate,
  streamingFiles,
  retainedSessions,
  streamingLoading,
  streamingUnavailable,
  metrics,
  metricsLoading,
  metricsUnavailable,
}: {
  allocatedBytes: number;
  budgetBytes: number;
  cacheEntries: number;
  cacheLoading: boolean;
  cacheUnavailable: boolean;
  transferRate: number | null;
  streamingFiles: number;
  retainedSessions: number;
  streamingLoading: boolean;
  streamingUnavailable: boolean;
  metrics?: MetricsResponse;
  metricsLoading: boolean;
  metricsUnavailable: boolean;
}) {
  const providers = metrics?.connections.providers ?? [];
  const cachePercent = budgetBytes > 0 ? Math.max(0, allocatedBytes * 100 / budgetBytes) : 0;
  const providerActiveConnections = providers.reduce(
    (total, provider) => total + Math.max(0, provider.activeConnections ?? 0),
    0,
  );
  const activeConnections = providers.length > 0
    ? providerActiveConnections
    : Math.max(0, metrics?.connections.inUse ?? 0);
  const connectionBudget = Math.max(0, metrics?.connections.budget ?? 0);
  const connectionPercent = percent(activeConnections, connectionBudget);

  return (
    <section
      className="overflow-hidden rounded-xl border border-border/80 bg-background/75 shadow-[inset_0_1px_0_rgba(255,255,255,.08)] dark:border-white/10 dark:bg-zinc-900/75"
      aria-label="Current system load"
      aria-live="polite"
    >
      <div className="grid grid-cols-2 gap-px bg-border/80 lg:grid-cols-4 dark:bg-white/10">
        <CapacityMetric
          icon={<HardDrive />}
          label="Stream cache"
          value={cacheUnavailable ? "Unavailable" : cacheLoading ? "—" : formatCapacityPercent(cachePercent)}
          detail={cacheUnavailable
            ? "Cache allocation could not load"
            : cacheLoading
              ? "Loading allocation"
              : `${formatBytes(allocatedBytes)} / ${formatBytes(budgetBytes)} · ${cacheEntries} ${cacheEntries === 1 ? "file" : "files"}`}
          loading={cacheLoading}
        >
          {!cacheUnavailable && !cacheLoading && (
            <CapacityBar label="Stream cache allocation" percent={cachePercent} />
          )}
        </CapacityMetric>
        <CapacityMetric
          icon={<Activity />}
          label="Stream output"
          value={metricsUnavailable ? "Unavailable" : transferRate == null ? "Measuring…" : formatRate(transferRate)}
          detail={metricsUnavailable ? "Transfer counter could not load" : "served bytes · 2 s sample"}
          loading={metricsLoading}
          live={!metricsUnavailable && !metricsLoading}
        />
        <CapacityMetric
          icon={<Radio />}
          label="Streaming now"
          value={streamingUnavailable ? "Unavailable" : streamingLoading ? "—" : String(streamingFiles)}
          detail={streamingUnavailable
            ? "Live stream state could not load"
            : `${retainedSessions} retained ${retainedSessions === 1 ? "capability" : "capabilities"}`}
          loading={streamingLoading}
          live={!streamingUnavailable && streamingFiles > 0}
        />
        <CapacityMetric
          icon={<Network />}
          label="NNTP pressure"
          value={metricsUnavailable ? "Unavailable" : metricsLoading ? "—" : `${activeConnections} / ${connectionBudget || "—"}`}
          detail={metricsUnavailable ? "Provider pools could not load" : "provider-active / global budget"}
          loading={metricsLoading}
        >
          {!metricsUnavailable && !metricsLoading && connectionBudget > 0 && (
            <CapacityBar label="Global NNTP connection pressure" percent={connectionPercent} />
          )}
        </CapacityMetric>
      </div>

      <div className="border-t border-border/80 px-4 py-3 dark:border-white/10">
        <div className="mb-3 flex items-center justify-between gap-3">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground dark:text-zinc-400">
            Provider connections
          </p>
          <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground/70 dark:text-zinc-500">
            active / configured
          </p>
        </div>
        {metricsUnavailable ? (
          <p className="text-xs text-muted-foreground" role="status">Provider telemetry is temporarily unavailable.</p>
        ) : metricsLoading ? (
          <div className="grid gap-3 sm:grid-cols-2" aria-label="Loading provider connections">
            <span className="h-9 animate-pulse rounded-md bg-muted dark:bg-white/5" />
            <span className="h-9 animate-pulse rounded-md bg-muted dark:bg-white/5" />
          </div>
        ) : providers.length === 0 ? (
          <p className="text-xs text-muted-foreground">No provider pools are configured.</p>
        ) : (
          <div className="grid gap-x-5 gap-y-3 sm:grid-cols-2">
            {providers.map((provider, index) => (
              <ProviderConnectionRow key={`${provider.name ?? "provider"}-${provider.priority ?? index}`} provider={provider} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function CapacityMetric({
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
        <span className={cn("text-cyan-700 dark:text-cyan-300", loading && "animate-pulse", live && "relative")}>
          {icon}
        </span>
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

function ProviderConnectionRow({ provider }: { provider: ProviderConnectionMetric }) {
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

function CapacityBar({ label, percent: value, compact = false, tripped = false }: { label: string; percent: number; compact?: boolean; tripped?: boolean }) {
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

function formatRate(bytesPerSecond: number) {
  return `${formatBytes(Math.max(0, bytesPerSecond))}/s`;
}

function formatCapacityPercent(value: number) {
  return value > 0 && value < 0.1 ? "<0.1%" : formatPercent(value);
}

function ViewButton({ active, onClick, label, icon }: { active: boolean; onClick: () => void; label: string; icon: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors [&_svg]:size-3.5",
        active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}{label}
    </button>
  );
}

function StreamsCards({ groups }: { groups: WorkGroup[] }) {
  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <section key={group.key} className="overflow-hidden rounded-2xl border bg-card">
          <WorkHeader group={group} />
          <div className="grid gap-3 border-t bg-muted/15 p-3 xl:grid-cols-2">
            {group.attempts.map((attempt) => <AttemptCard key={attempt.key} attempt={attempt} />)}
            {group.unmatchedVisits.map((visit) => <PlaybackOnlyCard key={visit.key} visit={visit} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

function WorkHeader({ group }: { group: WorkGroup }) {
  return (
    <header className="flex flex-col gap-2 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div className="min-w-0">
        <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.18em] text-cyan-700 dark:text-cyan-300">Work group</p>
        <h2 className="mt-1 truncate text-lg font-semibold" title={group.title}>{group.title}</h2>
        <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground" title={group.workId}>work / {group.workId || "unavailable"}</p>
      </div>
      <Badge variant="outline" className="w-fit font-mono uppercase">
        {group.attempts.length} {group.attempts.length === 1 ? "attempt" : "attempts"}
      </Badge>
    </header>
  );
}

function AttemptCard({ attempt }: { attempt: StreamAttempt }) {
  return (
    <article className={cn("min-w-0 overflow-hidden rounded-xl border bg-card", attempt.isFailed && "border-destructive/35") }>
      <div className="p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="min-w-0 break-words font-semibold" title={attempt.title}>{attempt.title}</h3>
              <AttemptStatus attempt={attempt} />
              {attempt.retentionPriority && (
                <Badge variant="outline" className="font-mono text-[9px] uppercase">
                  {attempt.retentionPriority} retention
                </Badge>
              )}
            </div>
            <ReleaseIdentifiers attempt={attempt} />
          </div>
          <AttemptActions attempt={attempt} />
        </div>

        {attempt.isFailed && (
          <FailureNotice attempt={attempt} />
        )}

        <div className="mt-5">
          <div className="mb-2 flex items-end justify-between gap-4">
            <div>
              <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground">Payload delivered</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{formatPercent(attempt.payloadPercent)}</p>
            </div>
            <p className="text-right font-mono text-[10px] text-muted-foreground">
              {formatBytes(attempt.bytesServed)} / {formatBytes(attempt.sizeBytes)}
            </p>
          </div>
          <ProgressBar label={`Payload delivered for ${attempt.title}`} percent={attempt.payloadPercent} />
        </div>

        <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <Datum icon={<HardDrive />} label="Chunks touched" value={attempt.chunkPercent == null ? "—" : formatPercent(attempt.chunkPercent)} detail={cacheDetail(attempt)} />
          <Datum icon={<Download />} label="Disk pre-download" value={attempt.diskPercent == null ? "—" : formatPercent(attempt.diskPercent)} detail={attempt.diskState} />
          <Datum icon={<UserRound />} label="Requested by" value={attempt.requester} detail={attempt.source} />
          <Datum icon={<MonitorPlay />} label="Last position" value={attempt.playbackPositionTicks == null ? "—" : formatTicks(attempt.playbackPositionTicks)} detail={attempt.device} />
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/20 px-4 py-2.5 font-mono text-[10px] text-muted-foreground">
        <span>{attempt.visits.length} playback {attempt.visits.length === 1 ? "visit" : "visits"}</span>
        {attempt.purgeAt && <span>purge {futureTime(attempt.purgeAt)}</span>}
        <span>{attempt.createdAt ? timeAgo(attempt.createdAt) : "time unavailable"}</span>
      </div>
    </article>
  );
}

function PlaybackOnlyCard({ visit }: { visit: PlaybackVisit }) {
  return (
    <article className="rounded-xl border border-dashed bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <MonitorPlay className="size-4 text-muted-foreground" />
        <h3 className="font-semibold">{visit.title || "Release name unavailable"}</h3>
        <Badge variant="outline">playback only</Badge>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">No stream token was reported, so this visit is not attached to a release attempt.</p>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Datum icon={<UserRound />} label="User" value={visit.userName || visit.userId || "Unknown"} />
        <Datum icon={<MonitorPlay />} label="Device" value={visit.device || "Unknown"} />
        <Datum icon={<Clock3 />} label="Position" value={formatTicks(visit.positionTicks)} />
        <Datum icon={<History />} label="Events" value={String(visit.eventCount)} detail={visit.state} />
      </div>
    </article>
  );
}

function StreamsTable({ groups }: { groups: WorkGroup[] }) {
  return (
    <div className="w-full overflow-x-auto rounded-xl border" role="region" aria-label="Streams table" tabIndex={0}>
      <table className="w-full min-w-[88rem] text-sm">
        <caption className="sr-only">Streams grouped by work and release attempt</caption>
        <thead className="bg-muted/50 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          <tr>
            <th scope="col" className="sticky left-0 z-10 min-w-72 bg-muted px-3 py-2 text-left font-medium">Release</th>
            <th scope="col" className="px-3 py-2 text-left font-medium">Outcome</th>
            <th scope="col" className="px-3 py-2 text-left font-medium">Requester</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Playback</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Payload</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Chunks</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Disk</th>
            <th scope="col" className="px-3 py-2 text-left font-medium">Source</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Started</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Actions</th>
          </tr>
        </thead>
        {groups.map((group) => (
          <tbody key={group.key}>
            <tr className="border-t bg-cyan-500/[.06]">
              <th colSpan={10} scope="rowgroup" className="px-3 py-2 text-left">
                <span className="font-medium">{group.title}</span>
                <span className="ml-2 font-mono text-[10px] font-normal text-muted-foreground">work / {group.workId || "unavailable"} · {group.attempts.length} attempts</span>
              </th>
            </tr>
            {group.attempts.map((attempt) => <AttemptTableRow key={attempt.key} attempt={attempt} />)}
            {group.unmatchedVisits.map((visit) => <PlaybackOnlyTableRow key={visit.key} visit={visit} />)}
          </tbody>
        ))}
      </table>
    </div>
  );
}

function AttemptTableRow({ attempt }: { attempt: StreamAttempt }) {
  return (
    <tr className={cn("border-t transition-colors hover:bg-muted/25", attempt.isFailed && "bg-destructive/[.035]") }>
      <th scope="row" className="sticky left-0 z-[1] bg-card px-3 py-3 text-left shadow-[8px_0_12px_-12px_hsl(var(--foreground))]">
        <p className="max-w-sm truncate font-medium" title={attempt.title}>{attempt.title}</p>
        <ReleaseIdentifiers attempt={attempt} compact />
      </th>
      <td className="px-3 py-3"><AttemptStatus attempt={attempt} />{attempt.isFailed && <p className="mt-1 max-w-52 truncate text-[10px] text-destructive" title={attempt.failureReason}>{attempt.failureReason || attempt.failureKind}</p>}</td>
      <td className="px-3 py-3"><p className="max-w-40 truncate">{attempt.requester}</p>{attempt.device && <p className="max-w-40 truncate text-[10px] text-muted-foreground">{attempt.device}</p>}</td>
      <td className="px-3 py-3 text-right tabular-nums">{attempt.playbackPositionTicks == null ? "—" : formatTicks(attempt.playbackPositionTicks)}</td>
      <td className="px-3 py-3 text-right tabular-nums"><p>{formatPercent(attempt.payloadPercent)}</p><p className="text-[10px] text-muted-foreground">{formatBytes(attempt.bytesServed)} / {formatBytes(attempt.sizeBytes)}</p></td>
      <td className="px-3 py-3 text-right tabular-nums">
        <p>{attempt.chunkPercent == null ? "—" : formatPercent(attempt.chunkPercent)}</p>
        {attempt.storageBytes != null && <p className="text-[10px] text-muted-foreground">{formatBytes(attempt.storageBytes)} resident</p>}
      </td>
      <td className="px-3 py-3 text-right tabular-nums">{attempt.diskPercent == null ? "—" : formatPercent(attempt.diskPercent)}</td>
      <td className="px-3 py-3">
        <Badge variant="muted">{attempt.source}</Badge>
        {attempt.container && <p className="mt-1 font-mono text-[10px] text-muted-foreground">{attempt.container}</p>}
        {attempt.retentionPriority && <p className="mt-1 font-mono text-[10px] text-muted-foreground">{attempt.retentionPriority} retention</p>}
      </td>
      <td className="px-3 py-3 text-right text-xs text-muted-foreground">{attempt.createdAt ? timeAgo(attempt.createdAt) : "—"}</td>
      <td className="px-3 py-3"><AttemptActions attempt={attempt} align="end" /></td>
    </tr>
  );
}

function PlaybackOnlyTableRow({ visit }: { visit: PlaybackVisit }) {
  return (
    <tr className="border-t border-dashed text-muted-foreground">
      <th scope="row" className="sticky left-0 bg-card px-3 py-3 text-left font-medium">{visit.title || "Release name unavailable"}<p className="font-mono text-[10px] font-normal">playback without token</p></th>
      <td className="px-3 py-3"><Badge variant="outline">{visit.state}</Badge></td>
      <td className="px-3 py-3">{visit.userName || visit.userId || "Unknown"}</td>
      <td className="px-3 py-3 text-right tabular-nums">{formatTicks(visit.positionTicks)}</td>
      <td className="px-3 py-3 text-right">—</td>
      <td className="px-3 py-3 text-right">—</td>
      <td className="px-3 py-3 text-right">—</td>
      <td className="px-3 py-3">{visit.source || "unknown"}</td>
      <td className="px-3 py-3 text-right text-xs">{visit.startedAt ? timeAgo(visit.startedAt) : "—"}</td>
      <td className="px-3 py-3 text-right">—</td>
    </tr>
  );
}

function AttemptStatus({ attempt }: { attempt: StreamAttempt }) {
  if (attempt.isFailed) return <Badge variant="destructive" className="uppercase">{attempt.failureKind || attempt.state || "failed"}</Badge>;
  if (attempt.isLive) return <Badge variant="success" className="gap-1 uppercase"><span className="size-1.5 rounded-full bg-current" />{attempt.state || "live"}</Badge>;
  if (attempt.state === "degraded") return <Badge className="border-transparent bg-amber-500/15 text-amber-800 dark:text-amber-300">degraded</Badge>;
  return <Badge variant="muted" className="uppercase">{attempt.state || "retained"}</Badge>;
}

function FailureNotice({ attempt }: { attempt: StreamAttempt }) {
  return (
    <div className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="status">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <div><p className="font-medium">{humanize(attempt.failureKind || "stream failed")}</p>{attempt.failureReason && <p className="mt-0.5 text-foreground/70">{attempt.failureReason}</p>}</div>
    </div>
  );
}

function ReleaseIdentifiers({ attempt, compact = false }: { attempt: StreamAttempt; compact?: boolean }) {
  const requestedDiffers = Boolean(
    attempt.requestedTitle
      && (attempt.requestedTitle !== attempt.title || attempt.requestedReleaseId !== attempt.releaseId),
  );
  return (
    <div className={cn("mt-1 space-y-0.5 font-mono text-[10px] text-muted-foreground", compact && "max-w-sm")}>
      {attempt.releaseId && <p className="truncate" title={attempt.releaseId}>release / {attempt.releaseId}</p>}
      {attempt.fileName && <p className="truncate" title={attempt.fileName}>file / {attempt.fileName}</p>}
      {requestedDiffers && (
        <p className={cn(compact ? "truncate" : "break-words", "text-amber-700 dark:text-amber-300")} title={`${attempt.requestedTitle} · ${attempt.requestedReleaseId ?? ""}`}>
          requested / {attempt.requestedTitle}{attempt.requestedReleaseId ? ` · ${attempt.requestedReleaseId}` : ""}
        </p>
      )}
    </div>
  );
}

function AttemptActions({ attempt, align = "start" }: { attempt: StreamAttempt; align?: "start" | "end" }) {
  const close = useCloseSession();
  const purge = usePurgeEphemeralFile();
  const [confirming, setConfirming] = useState<"close" | "purge" | null>(null);
  const pending = close.isPending || purge.isPending;

  async function confirm() {
    if (!attempt.token || !confirming) return;
    try {
      if (confirming === "close") {
        await close.mutateAsync(attempt.token);
        toast.success("Session closed.");
      } else {
        await purge.mutateAsync(attempt.token);
        toast.success("Ephemeral file purged.");
      }
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setConfirming(null);
    }
  }

  if (confirming) {
    return (
      <div className={cn("flex items-center gap-1", align === "end" && "justify-end")}>
        <Button size="sm" variant="destructive" onClick={confirm} disabled={pending}>{pending && <Loader2 className="animate-spin" />}Confirm</Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirming(null)} disabled={pending}>Cancel</Button>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-1", align === "end" && "justify-end")}>
      {attempt.token && (
        <Button asChild size="sm" variant="outline">
          <Link
            to="/sessions/$sessionToken"
            params={{ sessionToken: attempt.token }}
            aria-label={`Inspect stream ${attempt.title}`}
          >
            <ArrowUpRight />Inspect
          </Link>
        </Button>
      )}
      {attempt.isLive && attempt.token && (
        <Button size="sm" variant="ghost" onClick={() => setConfirming("close")} aria-label={`Force-close session ${attempt.title}`}><XCircle />Close</Button>
      )}
      {attempt.file && attempt.token && (
        <Button size="sm" variant="ghost" onClick={() => setConfirming("purge")} disabled={attempt.file.isStreaming} title={attempt.file.isStreaming ? "Actively streaming — close it before purging" : undefined} aria-label={`Purge ephemeral file ${attempt.title}`}><Trash2 />Purge</Button>
      )}
    </div>
  );
}

function Datum({ icon, label, value, detail }: { icon: ReactNode; label: string; value: string; detail?: string }) {
  return (
    <div className="min-w-0">
      <p className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground [&_svg]:size-3">{icon}{label}</p>
      <p className="mt-1 truncate text-sm font-semibold tabular-nums" title={value}>{value}</p>
      {detail && <p className="truncate text-[10px] text-muted-foreground" title={detail}>{detail}</p>}
    </div>
  );
}

function ProgressBar({ label, percent }: { label: string; percent: number }) {
  return (
    <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}>
      <div className="h-full rounded-full bg-cyan-500 transition-[width] duration-500" style={{ width: `${percent}%` }} />
    </div>
  );
}

export function buildWorkGroups(
  sessions: SessionWithTitle[],
  files: EphemeralFileResponse[],
  records: RecordWithOutcome[],
  events: EventWithTitle[],
): WorkGroup[] {
  const seeds = new Map<string, AttemptSeed>();
  const byToken = new Map<string, AttemptSeed>();
  const ensure = (source: string, token: string | null | undefined, identity: string) => {
    if (token && byToken.has(token)) return byToken.get(token)!;
    const key = token ? `token:${token}` : `${source}:${identity}`;
    const seed = seeds.get(key) ?? { key, token: token || undefined, visits: [] };
    seeds.set(key, seed);
    if (token) byToken.set(token, seed);
    return seed;
  };

  for (const record of records) {
    ensure("record", record.token, `${record.releaseId}:${record.createdAt}`).record = record;
  }
  for (const session of sessions) {
    ensure("session", session.token, `${session.releaseId}:${session.createdAt}`).live = session;
  }
  for (const file of files) {
    ensure("file", file.token, `${file.releaseId}:${file.createdAt}`).file = file;
  }

  const unmatched: PlaybackVisit[] = [];
  for (const visit of aggregatePlaybackEvents(events)) {
    if (visit.sessionToken) {
      ensure("playback", visit.sessionToken, visit.key).visits.push(visit);
    } else {
      unmatched.push(visit);
    }
  }

  const groups = new Map<string, WorkGroup>();
  const ensureGroup = (workId?: string, releaseId?: string, title?: string) => {
    const key = workId ? `work:${workId}` : `unmatched:${releaseId || "unknown"}`;
    const group = groups.get(key) ?? {
      key,
      workId,
      title: title || "Release name unavailable",
      attempts: [],
      unmatchedVisits: [],
      updatedAt: 0,
    };
    if (group.title === "Release name unavailable" && title) group.title = title;
    groups.set(key, group);
    return group;
  };

  for (const seed of seeds.values()) {
    const attempt = normalizeAttempt(seed);
    const group = ensureGroup(attempt.workId, attempt.releaseId, attempt.title);
    group.attempts.push(attempt);
    group.updatedAt = Math.max(group.updatedAt, timestamp(attempt.createdAt));
  }
  for (const visit of unmatched) {
    const group = ensureGroup(visit.workId, visit.releaseId, visit.title);
    group.unmatchedVisits.push(visit);
    group.updatedAt = Math.max(group.updatedAt, timestamp(visit.updatedAt));
  }

  for (const group of groups.values()) {
    group.attempts.sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt));
    group.unmatchedVisits.sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt));
    group.title = group.attempts[0]?.title || group.unmatchedVisits[0]?.title || group.title;
  }
  return [...groups.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

function normalizeAttempt(seed: AttemptSeed): StreamAttempt {
  const { live, file, record, visits } = seed;
  const latestVisit = [...visits].sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt))[0];
  const requestedTitle = clean(record?.title);
  const requestedReleaseId = clean(record?.releaseId);
  const title = clean(record?.resolvedTitle)
    || clean(file?.title)
    || clean(live?.title)
    || requestedTitle
    || clean(latestVisit?.title)
    || "Release name unavailable";
  const releaseId = clean(record?.resolvedReleaseId)
    || clean(live?.releaseId)
    || clean(file?.releaseId)
    || requestedReleaseId
    || clean(latestVisit?.releaseId);
  const workId = clean(live?.workId) || clean(file?.workId) || clean(record?.workId) || clean(latestVisit?.workId);
  const rawState = clean(live?.state) || clean(file?.state) || clean(record?.finalState) || (latestVisit?.state === "stop" ? "closed" : "playback");
  const preDownloadState = clean(file?.preDownloadState) || clean(live?.preDownloadState);
  const explicitFailureReason = clean(record?.failureReason);
  const closeReason = clean(record?.closeReason);
  const failureKind = clean(record?.failureKind)
    || (FAILURE_STATES.has(rawState.toLowerCase()) ? rawState : undefined)
    || ((preDownloadState ?? "").toLowerCase() === "failed" ? "pre-download failed" : undefined)
    || (explicitFailureReason || looksLikeFailure(closeReason) ? "stream failed" : undefined);
  const failureReason = explicitFailureReason
    || (failureKind ? closeReason : undefined)
    || (failureKind === "invalidated" ? "Release became unavailable while streaming." : undefined);
  const sizeBytes = live?.sizeBytes ?? file?.sizeBytes ?? record?.sizeBytes ?? 0;
  const bytesServed = live?.bytesServed ?? file?.bytesServed ?? record?.bytesServed ?? 0;
  const diskPercent = hasDiskProgress(live, file)
    ? clamp(file?.preDownloadPercent ?? live?.preDownloadPercent ?? 0)
    : undefined;
  const createdAt = clean(live?.createdAt) || clean(file?.createdAt) || clean(record?.createdAt) || clean(latestVisit?.startedAt);
  const isLive = Boolean(live);
  const isFailed = Boolean(failureKind);

  return {
    key: seed.key,
    token: seed.token,
    workId,
    title,
    releaseId,
    fileName: clean(file?.fileName),
    container: clean(live?.container) || clean(file?.container) || clean(record?.container),
    requestedTitle: requestedTitle && requestedTitle !== title ? requestedTitle : undefined,
    requestedReleaseId: requestedReleaseId && requestedReleaseId !== releaseId ? requestedReleaseId : undefined,
    state: rawState || "unknown",
    isLive,
    isFailed,
    isCompleted: !isLive && !isFailed && (COMPLETED_STATES.has(rawState.toLowerCase()) || latestVisit?.state === "stop"),
    failureKind,
    failureReason,
    requester: clean(live?.requestedByName) || clean(file?.requestedByName) || clean(record?.requestedByName) || clean(latestVisit?.userName) || clean(live?.requestedById) || clean(file?.requestedById) || clean(record?.requestedById) || clean(latestVisit?.userId) || "Unknown requester",
    source: clean(live?.client) || clean(file?.client) || clean(record?.client) || clean(latestVisit?.source) || "unknown",
    device: clean(latestVisit?.device),
    createdAt,
    bytesServed,
    sizeBytes,
    payloadPercent: percent(bytesServed, sizeBytes),
    chunkPercent: file ? clamp(file.estimatedStreamedPercent ?? 0) : undefined,
    chunksQueried: file?.chunksQueried,
    totalChunks: file?.totalChunks,
    diskPercent,
    diskState: preDownloadState || (file?.localCacheReady || live?.localCacheReady ? "completed" : undefined),
    retentionPriority: clean(file?.retentionPriority) || clean(live?.retentionPriority),
    storageBytes: file?.storageBytes,
    cachedChunks: file?.cachedChunks,
    purgeAt: clean(file?.purgeAt),
    playbackPositionTicks: visits.length ? Math.max(...visits.map((visit) => visit.positionTicks)) : undefined,
    playbackDurationTicks: visits.length ? Math.max(...visits.map((visit) => visit.durationTicks)) : undefined,
    visits,
    live,
    file,
    record,
  };
}

function aggregatePlaybackEvents(events: EventWithTitle[]): PlaybackVisit[] {
  const grouped = new Map<string, EventWithTitle[]>();
  for (const event of events) {
    const key = event.playbackSessionId
      ? `playback:${event.playbackSessionId}`
      : event.sessionToken
        ? `token:${event.sessionToken}:${event.source ?? "unknown"}:${event.externalUserId ?? "unknown"}`
        : `event:${event.id ?? event.receivedAt ?? grouped.size}`;
    grouped.set(key, [...(grouped.get(key) ?? []), event]);
  }

  return [...grouped.entries()].map(([key, entries]) => {
    const ordered = [...entries].sort((a, b) => timestamp(a.receivedAt) - timestamp(b.receivedAt));
    const first = ordered[0];
    const last = ordered.at(-1)!;
    return {
      key,
      sessionToken: clean(last.sessionToken),
      releaseId: clean(last.releaseId),
      workId: clean(last.workId),
      title: clean(last.title),
      source: clean(last.source),
      userId: clean(last.externalUserId),
      userName: clean(last.externalUserName),
      device: clean(last.deviceName),
      startedAt: clean(first.receivedAt),
      updatedAt: clean(last.receivedAt),
      positionTicks: Math.max(...ordered.map((event) => event.positionTicks ?? 0)),
      durationTicks: Math.max(...ordered.map((event) => event.durationTicks ?? 0)),
      state: clean(last.event) || "progress",
      eventCount: ordered.length,
    };
  });
}

function filterGroups(groups: WorkGroup[], filter: string, status: StatusFilter): WorkGroup[] {
  const needle = filter.trim().toLocaleLowerCase();
  return groups.flatMap((group) => {
    const groupMatches = !needle || [group.title, group.workId].some((value) => value?.toLocaleLowerCase().includes(needle));
    const attempts = group.attempts.filter((attempt) => {
      const statusMatches = status === "all"
        || (status === "live" && attempt.isLive)
        || (status === "failed" && attempt.isFailed)
        || (status === "completed" && attempt.isCompleted);
      const textMatches = groupMatches || [
        attempt.title,
        attempt.requestedTitle,
        attempt.releaseId,
        attempt.requestedReleaseId,
        attempt.workId,
        attempt.requester,
        attempt.device,
      ].some((value) => value?.toLocaleLowerCase().includes(needle));
      return statusMatches && textMatches;
    });
    const unmatchedVisits = status === "failed" || status === "live"
      ? []
      : group.unmatchedVisits.filter((visit) => groupMatches || [visit.title, visit.releaseId, visit.userName, visit.userId, visit.device].some((value) => value?.toLocaleLowerCase().includes(needle)));
    return attempts.length || unmatchedVisits.length ? [{ ...group, attempts, unmatchedVisits }] : [];
  });
}

function hasDiskProgress(live?: SessionWithTitle, file?: EphemeralFileResponse) {
  return Boolean(
    file?.preDownloadJobId
      || live?.preDownloadJobId
      || file?.preDownloadState
      || live?.preDownloadState
      || file?.localCacheReady
      || live?.localCacheReady
      || (file?.preDownloadTotalBytes ?? live?.preDownloadTotalBytes ?? 0) > 0,
  );
}

function clean(value?: string | null) {
  const result = value?.trim();
  return result || undefined;
}

function timestamp(value?: string | null) {
  const result = Date.parse(value ?? "");
  return Number.isFinite(result) ? result : 0;
}

function percent(value: number, total: number) {
  return total > 0 ? clamp(value * 100 / total) : 0;
}

function clamp(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

function formatPercent(value: number) {
  return `${value.toFixed(value > 0 && value < 10 ? 1 : 0)}%`;
}

function cacheDetail(attempt: StreamAttempt) {
  return [
    attempt.totalChunks ? `${attempt.chunksQueried ?? 0} / ${attempt.totalChunks}` : undefined,
    attempt.cachedChunks != null ? `${attempt.cachedChunks} cached` : undefined,
    attempt.storageBytes != null ? `${formatBytes(attempt.storageBytes)} resident` : undefined,
  ].filter(Boolean).join(" · ") || undefined;
}

function futureTime(value: string) {
  const difference = Date.parse(value) - Date.now();
  if (!Number.isFinite(difference)) return "time unavailable";
  if (difference <= 0) return "due now";
  const minutes = Math.ceil(difference / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.ceil(hours / 24)}d`;
}

function looksLikeFailure(value?: string) {
  return Boolean(value && /(fail|error|invalid|missing|article|repair|corrupt|unavailable)/i.test(value));
}

function humanize(value: string) {
  return value.replace(/[-_]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (character) => character.toUpperCase());
}
