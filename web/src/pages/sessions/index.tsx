import { useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, Grid2X2, Radio, Search, Table2 } from "lucide-react";
import {
  useEphemeralFiles,
  useMetrics,
  usePlaybackRanges,
  useSessions,
  useStreamingHistory,
  useStreamRecords,
} from "@/api/queries";
import { errorMessage } from "@/api/client";
import { EmptyOpsState, OpsHero } from "@/components/ops-page";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { buildWorkGroups, filterGroups, type StatusFilter } from "./model";
import { StreamsHero, useLiveTransferRate } from "./hero";
import { StreamsGroups, StreamsTable } from "./lanes";

type ViewMode = "cards" | "table";

export function SessionsPage() {
  const sessions = useSessions();
  const files = useEphemeralFiles();
  const metrics = useMetrics({ refetchInterval: 2_000 });
  const records = useStreamRecords(200, { refetchInterval: 5_000 });
  const events = useStreamingHistory(400, { refetchInterval: 5_000 });
  const playbackRanges = usePlaybackRanges(200, { refetchInterval: 5_000 });
  const [viewMode, setViewMode] = useState<ViewMode>("cards");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [filter, setFilter] = useState("");
  const groups = useMemo(
    () => buildWorkGroups(
      sessions.data ?? [],
      files.data ?? [],
      records.data ?? [],
      events.data ?? [],
      playbackRanges.data ?? [],
    ),
    [events.data, files.data, playbackRanges.data, records.data, sessions.data],
  );
  const visible = useMemo(() => filterGroups(groups, filter, status), [filter, groups, status]);
  const transferRate = useLiveTransferRate(metrics.data?.bytesServedTotal, metrics.dataUpdatedAt);
  const sources: Array<{ label: string; query: { isError: boolean; error: unknown; data?: unknown } }> = [
    { label: "Live sessions", query: sessions },
    { label: "Ephemeral files", query: files },
    { label: "Stream attempts", query: records },
    { label: "Playback events", query: events },
    { label: "Watched ranges", query: playbackRanges },
    { label: "System load", query: metrics },
  ];
  const errors = sources.filter(({ query }) => query.isError);
  const loading = [sessions, files, records, events].every((query) => query.isLoading && query.data == null);
  const fetching = [sessions, files, records, events, metrics].some((query) => query.isFetching);

  return (
    <div className="space-y-5">
      <OpsHero
        eyebrow="Stream diagnostics"
        title="Streams"
        description="One row per release a user tried. The newest attempt sets the status; slow providers, repairs, and missing articles surface as badges so the problem is visible before you open the console."
        accent="cyan"
      >
        <StreamsHero
          sessions={sessions.data ?? []}
          files={files.data ?? []}
          metrics={metrics.data}
          metricsLoading={metrics.isLoading}
          metricsUnavailable={metrics.isError}
          transferRate={transferRate}
          sessionsLoading={sessions.isLoading}
          sessionsUnavailable={sessions.isError}
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
            {visible.reduce((count, group) => count + group.lanes.length + group.unmatchedVisits.length, 0)} rows
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
        <StreamsGroups groups={visible} />
      ) : (
        <StreamsTable groups={visible} />
      )}
    </div>
  );
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
