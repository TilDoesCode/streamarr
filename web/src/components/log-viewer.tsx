import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CirclePause,
  CirclePlay,
  RefreshCw,
  RotateCcw,
  Search,
  Terminal,
} from "lucide-react";
import { errorMessage } from "@/api/client";
import {
  type LogMinimumLevel,
  type LogSource,
  useLogs,
} from "@/api/queries";
import type { LogEntryResponse, LogSourceStatusResponse } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const LEVELS: Array<{ value: LogMinimumLevel; label: string }> = [
  { value: "information", label: "Information +" },
  { value: "warning", label: "Warning +" },
  { value: "error", label: "Error" },
  { value: "debug", label: "Debug +" },
  { value: "trace", label: "Trace +" },
];

const MAXIMUM_LOG_ENTRIES = 500;
const LOAD_MORE_STEP = 200;

type DisplayLogEntry = LogEntryResponse & {
  id: string;
  atUtc: string;
  level: string;
  source: string;
  category: string;
  message: string;
};

interface DisplaySourceStatus {
  source: string;
  configured: boolean;
  available: boolean;
  message?: string;
}

export function LogViewer({
  streamToken,
  compact = false,
  initialLimit = compact ? 100 : 200,
}: {
  streamToken?: string;
  compact?: boolean;
  initialLimit?: number;
}) {
  const [source, setSource] = useState<LogSource>("all");
  const [minimumLevel, setMinimumLevel] = useState<LogMinimumLevel>("information");
  const [draftSearch, setDraftSearch] = useState("");
  const [search, setSearch] = useState("");
  const [following, setFollowing] = useState(true);
  const [limit, setLimit] = useState(() => Math.max(1, Math.min(MAXIMUM_LOG_ENTRIES, initialLimit)));
  const query = useLogs(
    { source, minimumLevel, search: search || undefined, streamToken, limit },
    {
      refetchInterval: following ? 2_000 : false,
      refetchOnWindowFocus: following,
      refetchOnReconnect: following,
    },
  );
  const sourceStatuses = (Array.isArray(query.data?.sources) ? query.data.sources : [])
    .map(normalizeSourceStatus);
  const visibleSourceStatuses = source === "all"
    ? sourceStatuses
    : sourceStatuses.filter((status) => status.source.toLowerCase() === source);
  const feedEntries = (Array.isArray(query.data?.entries) ? query.data.entries : [])
    .filter(isDisplayLogEntry);
  const entries = useMemo(
    () => [...feedEntries].sort(compareNewestFirst),
    [feedEntries],
  );
  const hasSnapshot = query.data !== undefined;

  function applySearch(event: React.FormEvent) {
    event.preventDefault();
    setSearch(draftSearch.trim());
  }

  function clearSearch() {
    setDraftSearch("");
    setSearch("");
  }

  return (
    <div
      className={cn(
        "min-w-0 overflow-hidden border bg-card text-card-foreground",
        compact ? "rounded-xl" : "rounded-2xl shadow-[0_24px_70px_-52px_rgba(15,23,42,.8)]",
      )}
    >
      <div className="flex flex-col gap-3 border-b bg-muted/20 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background text-primary">
            <Terminal className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              {streamToken ? "Correlated stream feed" : "Operator log feed"}
            </p>
            <p className="truncate text-sm font-medium">
              {streamToken ? "Core and Jellyfin events for this stream" : "Newest events first"}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SourceStatuses sources={visibleSourceStatuses} />
          <Button
            type="button"
            variant={following ? "secondary" : "outline"}
            size="sm"
            className="min-h-9"
            onClick={() => setFollowing((value) => !value)}
            aria-pressed={following}
          >
            {following ? <CirclePause aria-hidden="true" /> : <CirclePlay aria-hidden="true" />}
            {following ? "Pause" : "Follow live"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-9"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
            aria-label="Refresh logs"
          >
            <RefreshCw
              className={cn("size-4", query.isFetching && "animate-spin motion-reduce:animate-none")}
              aria-hidden="true"
            />
          </Button>
        </div>
      </div>

      <SourceStatusMessages sources={visibleSourceStatuses} />

      <form
        className="grid gap-3 border-b bg-background/70 p-4 sm:grid-cols-2 xl:grid-cols-[minmax(16rem,1fr)_11rem_12rem_auto] xl:items-end"
        onSubmit={applySearch}
        role="search"
      >
        <label className="min-w-0 sm:col-span-2 xl:col-span-1">
          <span className="mb-1.5 block font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Search messages
          </span>
          <span className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              value={draftSearch}
              onChange={(event) => setDraftSearch(event.target.value)}
              className="h-10 pl-9"
              placeholder="Exception, category, release…"
              aria-label="Search log messages"
            />
          </span>
        </label>

        <label>
          <span className="mb-1.5 block font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Source
          </span>
          <select
            value={source}
            onChange={(event) => setSource(event.target.value as LogSource)}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Log source"
          >
            <option value="all">Core + Jellyfin</option>
            <option value="core">Core</option>
            <option value="jellyfin">Jellyfin</option>
          </select>
        </label>

        <label>
          <span className="mb-1.5 block font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Minimum level
          </span>
          <select
            value={minimumLevel}
            onChange={(event) => setMinimumLevel(event.target.value as LogMinimumLevel)}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Minimum log level"
          >
            {LEVELS.map((level) => (
              <option key={level.value} value={level.value}>{level.label}</option>
            ))}
          </select>
        </label>

        <div className="flex gap-2 sm:col-span-2 xl:col-span-1">
          <Button type="submit" className="min-h-10 flex-1 xl:flex-none">Apply</Button>
          {(draftSearch || search) && (
            <Button type="button" variant="ghost" size="icon" className="size-10" onClick={clearSearch} aria-label="Clear log search">
              <RotateCcw aria-hidden="true" />
            </Button>
          )}
        </div>
      </form>

      {query.isError && hasSnapshot && (
        <div className="flex items-start gap-2 border-b border-amber-500/25 bg-amber-500/10 px-4 py-3 text-xs text-amber-900 dark:text-amber-200" role="status">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <p>The latest refresh failed. Showing the last log snapshot: {errorMessage(query.error)}</p>
        </div>
      )}

      {!hasSnapshot && query.isLoading ? (
        <LogSkeleton compact={compact} />
      ) : !hasSnapshot && query.isError ? (
        <div className="flex min-h-48 flex-col items-center justify-center gap-3 px-6 py-10 text-center" role="alert">
          <span className="flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <AlertTriangle className="size-5" aria-hidden="true" />
          </span>
          <div>
            <p className="font-medium">The log feed is unavailable</p>
            <p className="mt-1 max-w-xl text-sm text-muted-foreground">{errorMessage(query.error)}</p>
          </div>
        </div>
      ) : entries.length === 0 ? (
        <div className="flex min-h-48 flex-col items-center justify-center px-6 py-10 text-center">
          <span className="flex size-10 items-center justify-center rounded-full border bg-muted/30 text-muted-foreground">
            <Terminal className="size-5" aria-hidden="true" />
          </span>
          <p className="mt-3 font-medium">No matching log entries</p>
          <p className="mt-1 max-w-md text-sm leading-6 text-muted-foreground">
            {streamToken
              ? "No Core or Jellyfin messages have been correlated with this stream in the retained window."
              : "Adjust the source, level, or search filter to widen the retained window."}
          </p>
        </div>
      ) : (
        <ol
          className={cn("divide-y overflow-y-auto", compact ? "max-h-[32rem]" : "max-h-[calc(100dvh-20rem)] min-h-72")}
          role="log"
          aria-label={streamToken ? "Logs for this stream" : "Core and Jellyfin logs"}
          aria-busy={query.isFetching}
          tabIndex={0}
        >
          {entries.map((entry) => (
            <LogRow key={`${entry.source}:${entry.id}`} entry={entry} compact={compact} />
          ))}
        </ol>
      )}

      {hasSnapshot && (
        <div className="flex flex-col gap-2 border-t bg-muted/15 px-4 py-3 text-[11px] text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <p className="font-mono tabular-nums">
            {entries.length} {entries.length === 1 ? "entry" : "entries"} · snapshot {formatSnapshotTime(query.data.generatedAt ?? "")}
          </p>
          {query.data.hasMore && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="self-start sm:self-auto"
              onClick={() => setLimit((value) => Math.min(MAXIMUM_LOG_ENTRIES, value + LOAD_MORE_STEP))}
              disabled={limit >= MAXIMUM_LOG_ENTRIES}
            >
              {limit >= MAXIMUM_LOG_ENTRIES ? "Refine filters for older entries" : "Show more retained entries"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function SourceStatuses({ sources }: { sources: DisplaySourceStatus[] }) {
  if (sources.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="Log source status">
      {sources.map((status) => (
        <span
          key={status.source}
          className="inline-flex items-center gap-1.5 rounded-full border bg-background/70 px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground"
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              status.available ? "bg-emerald-500" : status.configured ? "bg-amber-500" : "bg-muted-foreground/40",
            )}
            aria-hidden="true"
          />
          <span>
            {`${sourceLabel(status.source)} ${status.available ? "available" : status.configured ? "unavailable" : "not configured"}`}
          </span>
        </span>
      ))}
    </div>
  );
}

function SourceStatusMessages({ sources }: { sources: DisplaySourceStatus[] }) {
  const unavailable = sources.filter((status) => !status.available && status.message);
  if (unavailable.length === 0) return null;

  return (
    <div
      className="space-y-1 border-b bg-muted/15 px-4 py-2.5 text-xs leading-5 text-muted-foreground sm:px-5"
      role="status"
      aria-label="Log source diagnostics"
    >
      {unavailable.map((status) => (
        <p key={status.source} className="[overflow-wrap:anywhere]">
          <span className="font-medium text-foreground">
            {sourceLabel(status.source)} {status.configured ? "unavailable" : "not configured"}:
          </span>{" "}
          {status.message}
        </p>
      ))}
    </div>
  );
}

function LogRow({ entry, compact }: { entry: DisplayLogEntry; compact: boolean }) {
  const level = normalizeLevel(entry.level);
  return (
    <li className={cn("relative min-w-0 px-4 py-3.5 transition-colors hover:bg-muted/20 sm:px-5", levelRail(level))}>
      <div
        className={cn(
          "grid min-w-0 gap-x-3 gap-y-2",
          compact
            ? "xl:grid-cols-[7.75rem_5.5rem_10rem_minmax(0,1fr)] xl:items-start"
            : "lg:grid-cols-[7.75rem_5.5rem_10rem_minmax(0,1fr)] lg:items-start",
        )}
      >
        <time
          dateTime={entry.atUtc}
          title={formatFullTimestamp(entry.atUtc)}
          className="font-mono text-[10px] tabular-nums text-muted-foreground"
        >
          {formatLogTime(entry.atUtc)}
        </time>
        <LevelBadge level={level} />
        <div className={cn("flex min-w-0 items-center gap-1.5", compact ? "xl:block" : "lg:block")}>
          <span className={cn("font-mono text-[9px] font-semibold uppercase tracking-wider", sourceTone(entry.source))}>
            {sourceLabel(entry.source)}
          </span>
          <span className={cn("text-muted-foreground/40", compact ? "xl:hidden" : "lg:hidden")}>/</span>
          <span className="block min-w-0 truncate font-mono text-[9px] text-muted-foreground" title={entry.category}>
            {entry.category}
          </span>
        </div>
        <div
          className={cn(
            "min-w-0",
            compact
              ? "xl:col-start-4 xl:row-start-1 xl:row-span-2"
              : "lg:col-start-4 lg:row-start-1 lg:row-span-2",
          )}
        >
          <p className="whitespace-pre-wrap text-sm leading-5 [overflow-wrap:anywhere]">{entry.message}</p>
          {(entry.releaseId || entry.workId) && (
            <div className="mt-2 flex flex-wrap gap-1.5 font-mono text-[9px] text-muted-foreground">
              {entry.releaseId && <span className="max-w-full truncate rounded border bg-muted/25 px-1.5 py-0.5" title={entry.releaseId}>release / {entry.releaseId}</span>}
              {entry.workId && <span className="max-w-full truncate rounded border bg-muted/25 px-1.5 py-0.5" title={entry.workId}>work / {entry.workId}</span>}
            </div>
          )}
          {entry.exception && (
            <details className="mt-2 rounded-lg border border-destructive/20 bg-destructive/[.035] open:bg-destructive/[.055]">
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-destructive outline-none focus-visible:ring-2 focus-visible:ring-ring">
                Exception details
              </summary>
              <pre className="max-h-64 overflow-auto border-t border-destructive/15 px-3 py-2.5 font-mono text-[10px] leading-5 text-foreground/80">
                {entry.exception}
              </pre>
            </details>
          )}
        </div>
      </div>
    </li>
  );
}

function LevelBadge({ level }: { level: string }) {
  return (
    <span
      className={cn(
        "w-fit rounded-full border px-2 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-[0.13em]",
        level === "error" && "border-rose-500/25 bg-rose-500/10 text-rose-700 dark:text-rose-300",
        level === "warning" && "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        level === "information" && "border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300",
        level === "debug" && "border-violet-500/20 bg-violet-500/10 text-violet-700 dark:text-violet-300",
        level === "trace" && "border-muted-foreground/20 bg-muted text-muted-foreground",
      )}
    >
      {level}
    </span>
  );
}

function LogSkeleton({ compact }: { compact: boolean }) {
  return (
    <div className={cn("space-y-px bg-border", compact ? "h-64" : "h-96")} role="status" aria-label="Loading logs">
      {[0, 1, 2, 3].map((key) => (
        <div key={key} className="h-20 animate-pulse bg-card p-4 motion-reduce:animate-none">
          <div className="h-3 w-1/3 rounded bg-muted" />
          <div className="mt-3 h-2.5 w-4/5 rounded bg-muted/70" />
        </div>
      ))}
    </div>
  );
}

function compareNewestFirst(a: DisplayLogEntry, b: DisplayLogEntry) {
  return Date.parse(b.atUtc) - Date.parse(a.atUtc);
}

function normalizeLevel(value: string): string {
  const level = value.toLowerCase();
  if (level === "critical" || level === "fatal") return "error";
  if (level === "warn") return "warning";
  if (level === "info") return "information";
  return ["error", "warning", "information", "debug", "trace"].includes(level) ? level : "information";
}

function levelRail(level: string): string {
  if (level === "error") return "border-l-2 border-l-rose-500 bg-rose-500/[.025]";
  if (level === "warning") return "border-l-2 border-l-amber-500 bg-amber-500/[.02]";
  return "border-l-2 border-l-transparent";
}

function sourceTone(source: string): string {
  return source.toLowerCase() === "jellyfin" ? "text-cyan-700 dark:text-cyan-300" : "text-primary";
}

function sourceLabel(source: string): string {
  return source.toLowerCase() === "jellyfin" ? "Jellyfin" : source.toLowerCase() === "core" ? "Core" : source;
}

function isDisplayLogEntry(entry: LogEntryResponse): entry is DisplayLogEntry {
  return typeof entry.id === "string"
    && typeof entry.atUtc === "string"
    && typeof entry.level === "string"
    && typeof entry.source === "string"
    && typeof entry.category === "string"
    && typeof entry.message === "string";
}

function normalizeSourceStatus(status: LogSourceStatusResponse): DisplaySourceStatus {
  return {
    source: status.source ?? "unknown",
    configured: status.configured === true,
    available: status.available === true,
    message: status.message ?? undefined,
  };
}

function formatLogTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  return at.toISOString().slice(11, 23) + "Z";
}

function formatFullTimestamp(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toISOString();
}

function formatSnapshotTime(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "unknown" : at.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}
