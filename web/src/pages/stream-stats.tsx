import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Box,
  Check,
  Clock3,
  Copy,
  Database,
  Download,
  Film,
  Gauge,
  HardDrive,
  MonitorPlay,
  Network,
  Radio,
  Server,
  ShieldCheck,
  Terminal,
  UserRound,
  Wifi,
  Zap,
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
import { ApiError, errorMessage } from "@/api/client";
import { useEphemeralFiles, useMetrics, usePreDownloads, useSessionArticles, useSessions, useStreamingHistory, useStreamRecord } from "@/api/queries";
import type { ArticleMapResponse, PreDownloadJobResponse, SessionResponse, StreamEventResponse, StreamingHistoryResponse, StreamRecordResponse, TtffSpanResponse } from "@/api/types";
import { Button } from "@/components/ui/button";
import { ArticleMap } from "@/components/article-map";
import { LogViewer } from "@/components/log-viewer";
import { cn, formatBytes, formatTicks, timeAgo } from "@/lib/utils";

interface RateSample {
  index: number;
  rate: number;
}

export function StreamStatsPage({ sessionToken }: { sessionToken?: string } = {}) {
  const params = useParams({ strict: false }) as { sessionToken?: string };
  const token = sessionToken ?? params.sessionToken ?? "";
  const sessions = useSessions({ refetchInterval: 2_000 });
  const files = useEphemeralFiles({ refetchInterval: 2_000 });
  const metrics = useMetrics({ refetchInterval: 3_000 });
  const history = useStreamingHistory(400);
  const preDownloads = usePreDownloads(token);
  const session = sessions.data?.find((item) => item.token === token);
  const articleMap = useSessionArticles(token, {
    live: Boolean(session),
  });
  const file = files.data?.find((item) => item.token === token);
  // Live-only telemetry (below) needs the live session; once it's gone, fall back to the
  // permanent stream-history record so this page keeps working after the fact (BRIEF §11).
  const record = useStreamRecord(token, { enabled: token.length > 0 && !session && !sessions.isLoading });
  const [now, setNow] = useState(() => Date.now());
  const rates = useTransferRate(session);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);

  const events = useMemo(
    () => matchingEvents(history.data ?? [], session),
    [history.data, session],
  );

  if (sessions.isLoading || files.isLoading) return <StreamStatsSkeleton />;

  if (sessions.isError || files.isError) {
    return (
      <StreamStatsMessage
        icon={<AlertTriangle />}
        eyebrow="Telemetry unavailable"
        title="The stream probe could not connect"
        description={errorMessage(sessions.error ?? files.error)}
      />
    );
  }

  if (!session) {
    if (record.isLoading) return <StreamStatsSkeleton />;
    if (record.data) return <HistoricalStreamConsole record={record.data} articleMap={articleMap} preDownloads={preDownloads} />;

    const notFound = record.error instanceof ApiError && record.error.status === 404;
    return (
      <StreamStatsMessage
        icon={<Radio />}
        eyebrow={notFound ? "Nothing retained" : "Telemetry unavailable"}
        title={notFound ? "This stream left no trace" : "The stream record could not load"}
        description={
          notFound
            ? "No live session, and nothing in the permanent stream history for this token — it may predate the retention window, or the token is wrong."
            : errorMessage(record.error)
        }
      />
    );
  }

  const size = session.sizeBytes ?? file?.sizeBytes ?? 0;
  const served = session.bytesServed ?? file?.bytesServed ?? 0;
  const payloadPercent = percent(served, size);
  const chunkPercent = Math.max(0, Math.min(100, file?.estimatedStreamedPercent ?? 0));
  const cachedPercent = percent(file?.cachedChunks ?? 0, file?.totalChunks ?? 0);
  const ageSeconds = Math.max(1, (now - Date.parse(session.createdAt ?? "")) / 1_000);
  const averageRate = served / ageSeconds;
  const currentRate = rates.at(-1)?.rate ?? 0;
  const peakRate = Math.max(0, ...rates.map((sample) => sample.rate));
  const etaRate = currentRate > 0 ? currentRate : averageRate;
  const etaSeconds = etaRate > 0 ? Math.max(0, size - served) / etaRate : null;
  const expiresAt = session.expiresAt ?? file?.purgeAt;
  const connectionBudget = metrics.data?.connections.budget ?? 0;
  const globalConnections = metrics.data?.connections.inUse ?? 0;
  const requester = session.requestedByName || session.requestedById || "Unattributed request";
  const title = file?.title || session.releaseId || "Untitled stream";

  return (
    <div className="stream-console relative isolate overflow-hidden rounded-[1.35rem] border bg-card text-card-foreground shadow-[0_22px_65px_-42px_rgba(15,23,42,.35)] dark:shadow-[0_24px_75px_-44px_rgba(0,0,0,.9)]">
      <ConsoleBackdrop />

      <header className="relative border-b bg-muted/20 px-4 py-4 dark:bg-muted/10 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-center gap-3">
          <Button asChild variant="ghost" size="sm" className="-ml-2 text-muted-foreground hover:bg-muted hover:text-foreground">
            <Link to="/sessions"><ArrowLeft />All streams</Link>
          </Button>
          <span className="hidden h-4 w-px bg-border sm:block" />
          <LiveIndicator fetching={sessions.isFetching || files.isFetching || articleMap.isFetching || preDownloads.isFetching} />
          <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">
            probe interval / 2.0s
          </span>
        </div>
      </header>

      <main className="relative">
        <section className="grid min-w-0 grid-cols-1 border-b xl:grid-cols-[minmax(0,1.3fr)_minmax(25rem,.7fr)]">
          <div className="min-w-0 px-4 py-8 sm:px-6 lg:px-8 lg:py-10 xl:border-r">
            <div className="max-w-4xl">
              <div className="flex items-center gap-3 font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-primary">
                <span className="h-px w-10 bg-primary/70" />
                Stream telemetry / {session.client || "unknown source"}
              </div>
              <div className="mt-5 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div className="min-w-0">
                  <h2 className="max-w-3xl break-words text-2xl font-semibold leading-tight tracking-[-0.035em] text-foreground sm:text-3xl lg:text-[2.5rem]">
                    {title}
                  </h2>
                  <p className="mt-2 truncate font-mono text-[11px] text-muted-foreground" title={file?.fileName ?? session.releaseId ?? undefined}>
                    {file?.fileName || session.releaseId}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <StatusBadge state={session.state} />
                  <span className="rounded-full border bg-background/60 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    {session.container || "stream"}
                  </span>
                </div>
              </div>
            </div>

            <div className="mt-9">
              <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.17em] text-muted-foreground">Payload delivered</p>
                  <p className="mt-1 font-mono text-3xl font-medium tabular-nums text-foreground">
                    {payloadPercent.toFixed(payloadPercent < 10 ? 1 : 0)}<span className="ml-1 text-base text-muted-foreground">%</span>
                  </p>
                </div>
                <div className="font-mono text-xs text-muted-foreground sm:text-right">
                  <p><span className="text-foreground">{formatBytes(served)}</span> served</p>
                  <p>{formatBytes(Math.max(0, size - served))} remaining of {formatBytes(size)}</p>
                </div>
              </div>
              <SegmentRail percent={payloadPercent} cachedPercent={cachedPercent} />
              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/80">
                <span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-primary" /> delivered bytes</span>
                <span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full border border-primary/60" /> cache resident</span>
                <span>{(file?.chunksQueried ?? 0).toLocaleString()} unique chunks touched</span>
              </div>
            </div>
          </div>

          <div className="min-w-0 border-t bg-muted/25 p-4 dark:bg-muted/15 sm:p-6 xl:border-t-0 lg:p-8">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  <Activity className="size-3.5 text-primary" /> Instant transfer rate
                </p>
                <p className="mt-3 font-mono text-4xl font-medium tracking-[-0.05em] text-foreground sm:text-5xl">
                  {formatRate(currentRate)}
                </p>
              </div>
              <span className="mt-1 flex size-9 items-center justify-center rounded-full border border-primary/20 bg-primary/10 text-primary">
                <Zap className="size-4" />
              </span>
            </div>
            <div className="mt-5 h-36 min-w-0">
              <RateChart samples={rates} />
            </div>
            <div className="grid grid-cols-3 divide-x border-t pt-4 font-mono">
              <MiniMetric label="Average" value={formatRate(averageRate)} />
              <MiniMetric label="Peak" value={formatRate(peakRate)} className="pl-4" />
              <MiniMetric label="ETA" value={formatDuration(etaSeconds)} className="pl-4" />
            </div>
          </div>
        </section>

        <StreamLogPanel token={token} />

        <PreDownloadDiagnostics sessionToken={token} state={preDownloads} />

        <ArticleMapPanel state={articleMap} />

        <TtffFlamegraph spans={session.timeline ?? []} />

        <section className="grid grid-cols-2 border-b md:grid-cols-4">
          <MetricCell icon={<Radio />} label="Bytes on wire" value={formatBytes(served)} detail={`${payloadPercent.toFixed(1)}% of payload`} />
          <MetricCell icon={<Box />} label="Chunk coverage" value={`${chunkPercent.toFixed(chunkPercent < 10 ? 1 : 0)}%`} detail={`${file?.chunksQueried ?? 0} / ${file?.totalChunks ?? 0} queried`} />
          <MetricCell icon={<Network />} label="NNTP commands" value={(session.nntpCommandsTotal ?? 0).toLocaleString()} detail={`${session.nntpConnectionsInFlight ?? 0} currently in flight`} />
          <MetricCell icon={<Clock3 />} label="Expiry clock" value={formatCountdown(expiresAt, now)} detail={`last touched ${timeAgo(session.lastAccessedAt, now)}`} />
        </section>

        <section className="grid min-w-0 grid-cols-1 xl:grid-cols-[minmax(0,1.18fr)_minmax(23rem,.82fr)]">
          <div className="min-w-0 border-b p-4 sm:p-6 lg:p-8 xl:border-b-0 xl:border-r">
            <SectionHeading
              icon={<Wifi />}
              eyebrow="Delivery topology"
              title="The live data path"
              detail="A single request traced from player to pooled Usenet transport."
            />
            <DataPath
              client={session.client || "unknown client"}
              connections={session.nntpConnectionsInFlight ?? 0}
              globalConnections={globalConnections}
              connectionBudget={connectionBudget}
              cachedChunks={file?.cachedChunks ?? 0}
              providers={metrics.data?.connections.providers ?? []}
            />

            <div className="mt-10 grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2">
              <DetailCell icon={<UserRound />} label="Requester" value={requester} detail={session.requestedById || "No stable user ID reported"} />
              <DetailCell icon={<MonitorPlay />} label="Originating client" value={session.client || "Unknown"} detail="Capability session source" />
              <DetailCell icon={<HardDrive />} label="Segment cache" value={formatBytes(file?.storageBytes)} detail={`${file?.cachedChunks ?? 0} chunks currently resident`} />
              <DetailCell icon={<Gauge />} label="Read pressure" value={`${session.nntpConnectionsInFlight ?? 0} / ${connectionBudget || "—"}`} detail="session in-flight / global budget" />
            </div>
          </div>

          <aside className="min-w-0 p-4 sm:p-6 lg:p-8">
            <SectionHeading
              icon={<Terminal />}
              eyebrow="Session ledger"
              title="Identity & lifecycle"
              detail="Exact values for correlating UI symptoms with server logs."
            />
            <dl className="mt-7 divide-y border-y">
              <LedgerRow label="Created" value={formatTimestamp(session.createdAt)} detail={timeAgo(session.createdAt, now)} />
              <LedgerRow label="Last access" value={formatTimestamp(session.lastAccessedAt)} detail={timeAgo(session.lastAccessedAt, now)} />
              <LedgerRow label="Expires" value={formatTimestamp(expiresAt)} detail={formatCountdown(expiresAt, now)} />
              <LedgerRow label="Session age" value={formatDuration(ageSeconds)} detail="wall-clock lifetime" />
              <LedgerRow label="MIME route" value={mimeFor(session.container)} detail="direct byte-range delivery" />
            </dl>

            <div className="mt-7 space-y-3">
              <Identifier label="Capability token" value={session.token || "—"} secret />
              <Identifier label="Release ID" value={session.releaseId || "—"} />
              <Identifier label="Work ID" value={session.workId || "—"} />
            </div>
          </aside>
        </section>

        <section className="border-t p-4 sm:p-6 lg:p-8">
          <SectionHeading
            icon={<Database />}
            eyebrow="Playback correlation"
            title="Recent client events"
            detail="Jellyfin and front-end events matching this release and work."
          />
          <EventTimeline events={events} />
        </section>
      </main>
    </div>
  );
}

interface PreDownloadQueryState {
  data?: PreDownloadJobResponse[];
  dataUpdatedAt: number;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  error: unknown;
}

function StreamLogPanel({ token }: { token: string }) {
  return (
    <section className="border-b bg-muted/[.06] px-4 py-7 sm:px-6 lg:px-8 lg:py-9" aria-label="Stream logs">
      <SectionHeading
        icon={<Terminal />}
        eyebrow="Correlated runtime output"
        title="Core & Jellyfin logs"
        detail="Raw operator messages and exceptions attributed to this stream, newest first."
      />
      <div className="mt-6">
        <LogViewer streamToken={token} compact />
      </div>
    </section>
  );
}

function PreDownloadDiagnostics({
  sessionToken,
  state,
}: {
  sessionToken: string;
  state: PreDownloadQueryState;
}) {
  const hasSnapshot = state.data !== undefined;
  const jobs = state.data ?? [];
  const updatedAt = state.dataUpdatedAt > 0
    ? new Date(state.dataUpdatedAt).toISOString()
    : undefined;

  return (
    <section className="border-b bg-[linear-gradient(135deg,hsl(var(--primary)/.055),transparent_42%)] px-4 py-7 sm:px-6 lg:px-8 lg:py-9" aria-label="Pre-download diagnostics">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <SectionHeading
          icon={<Download />}
          eyebrow="Background materialization"
          title="Pre-download diagnostics"
          detail="Trigger intent and disk transfer are reported independently, so playback progress is never inferred from downloaded bytes."
        />
        <span className="flex shrink-0 items-center gap-2 rounded-full border bg-background/60 px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.15em] text-muted-foreground">
          <span className={cn("size-1.5 rounded-full", state.isFetching ? "animate-pulse bg-primary" : "bg-muted-foreground/50")} />
          {state.isFetching ? "refreshing jobs" : `${jobs.length} related ${jobs.length === 1 ? "job" : "jobs"}`}
        </span>
      </div>

      {state.isError && hasSnapshot && (
        <div className="mt-5 flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-xs text-amber-900 dark:text-amber-200" role="status">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <p>
            The latest refresh failed. Showing the last job snapshot{updatedAt ? ` from ${formatTimestamp(updatedAt)}` : ""}: {errorMessage(state.error)}
          </p>
        </div>
      )}

      {!hasSnapshot && state.isLoading ? (
        <div className="mt-6 grid gap-3 xl:grid-cols-2" aria-label="Loading pre-download jobs">
          {[0, 1].map((key) => (
            <div key={key} className="h-64 animate-pulse rounded-2xl border bg-muted/35" />
          ))}
        </div>
      ) : !hasSnapshot && state.isError ? (
        <div className="mt-6 flex items-start gap-3 rounded-xl border border-destructive/25 bg-destructive/5 p-4 text-sm" role="alert">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <AlertTriangle className="size-4" />
          </span>
          <div>
            <p className="font-medium text-foreground">Pre-download telemetry is unavailable</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{errorMessage(state.error)}</p>
          </div>
        </div>
      ) : jobs.length === 0 ? (
        <div className="mt-6 flex items-start gap-3 rounded-xl border border-dashed bg-card/65 p-4 text-sm">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Download className="size-4" />
          </span>
          <div>
            <p className="font-medium text-foreground">No pre-download has been triggered for this session</p>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
              A job appears here after the configured watch-time threshold is crossed, whether this session initiated the work or is the prepared next episode.
            </p>
          </div>
        </div>
      ) : (
        <div className="mt-6 grid gap-4 xl:grid-cols-2">
          {jobs.map((job) => (
            <PreDownloadJobCard key={job.id} job={job} sessionToken={sessionToken} />
          ))}
        </div>
      )}
    </section>
  );
}

function PreDownloadJobCard({ job, sessionToken }: { job: PreDownloadJobResponse; sessionToken: string }) {
  const isSource = job.sourceToken === sessionToken;
  const isTarget = job.targetToken === sessionToken
    || (job.kind === "currentFile" && job.sourceToken === sessionToken);
  const relation = isSource && isTarget
    ? "source + target"
    : isSource
      ? "source session"
      : "prepared target";
  const diskPercent = clampedPercent(job.progressPercent);
  const watchPercent = job.watchProgressPercent == null
    ? null
    : clampedPercent(job.watchProgressPercent);
  const state = job.state || "queued";
  const issue = ["failed", "skipped", "cancelled"].includes(state);
  const nextEpisode = job.kind === "nextEpisode";

  return (
    <article className="min-w-0 overflow-hidden rounded-2xl border bg-card/90 shadow-[0_18px_45px_-38px_rgba(15,23,42,.65)]">
      <div className="border-b px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
            {nextEpisode ? <Film className="size-4" /> : <HardDrive className="size-4" />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="font-semibold tracking-tight text-foreground">
                {nextEpisode ? "Prepare the next episode" : "Finish the current file"}
              </h4>
              <JobStateBadge state={state} />
              <span className="rounded-full border bg-muted/30 px-2 py-0.5 font-mono text-[8px] uppercase tracking-[0.14em] text-muted-foreground">
                {relation}
              </span>
            </div>
            <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{job.reason}</p>
          </div>
        </div>

        <JobRoute job={job} sessionToken={sessionToken} />
      </div>

      <div className="grid gap-px bg-border md:grid-cols-2">
        <JobProgressPanel
          eyebrow="Watch trigger snapshot"
          value={watchPercent == null ? formatTicks(job.watchPositionTicks) : `${formatPercent(watchPercent)} watched`}
          detail={watchSnapshotDetail(job)}
          percent={watchPercent ?? watchThresholdPercent(job)}
          barClassName="bg-sky-500"
          ariaLabel="Client-reported watch progress at the time the pre-download was triggered"
          footnote="Captured from client watch position; never inferred from download bytes."
        />
        <JobProgressPanel
          eyebrow="Disk pre-download"
          value={downloadProgressValue(job, diskPercent)}
          detail={downloadProgressDetail(job)}
          percent={diskPercent}
          barClassName={state === "completed" ? "bg-emerald-500" : issue ? "bg-amber-500" : "bg-primary"}
          ariaLabel="Ephemeral disk pre-download progress"
          footnote="Bytes written to the ephemeral file; independent of watch position and playback bytes."
          active={state === "downloading"}
        />
      </div>

      {issue && (
        <div className={cn(
          "flex items-start gap-2 border-t px-4 py-3 text-xs sm:px-5",
          state === "failed"
            ? "border-rose-500/25 bg-rose-500/10 text-rose-900 dark:text-rose-200"
            : "border-amber-500/25 bg-amber-500/10 text-amber-900 dark:text-amber-200",
        )} role="status">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <p>
            <span className="font-mono text-[9px] font-semibold uppercase tracking-wider">{job.errorCode || state}</span>
            <span className="ml-2">{job.errorMessage || outcomeFallback(state)}</span>
          </p>
        </div>
      )}

      <div className="flex flex-col gap-1 border-t bg-muted/20 px-4 py-2.5 font-mono text-[9px] text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <span>{job.priority || "low"} priority · queued {timeAgo(job.queuedAt)}</span>
        <span className="truncate" title={job.id ?? undefined}>job / {job.id || "unknown"}</span>
      </div>
    </article>
  );
}

function JobRoute({ job, sessionToken }: { job: PreDownloadJobResponse; sessionToken: string }) {
  const sourceHere = job.sourceToken === sessionToken;
  const targetHere = job.targetToken === sessionToken
    || (job.kind === "currentFile" && sourceHere);
  const targetWork = job.targetWorkId
    || (job.kind === "currentFile" ? job.sourceWorkId : undefined);
  const targetTitle = job.kind === "currentFile"
    ? "Current movie or episode"
    : job.targetTitle || "Resolving canonical next episode";
  const episode = episodeCode(job.targetSeasonNumber, job.targetEpisodeNumber);

  return (
    <div className="mt-4 grid min-w-0 items-stretch gap-2 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:items-center">
      <RouteNode
        label="Playback source"
        value={job.sourceWorkId || job.sourceReleaseId || "Unknown source"}
        detail={sourceHere ? "this session" : "originating session"}
        active={sourceHere}
      />
      <span className="flex items-center justify-center text-primary/55">
        <ArrowRight className="size-3.5 rotate-90 md:rotate-0" />
      </span>
      <RouteNode
        label={job.kind === "nextEpisode" ? "Episode target" : "Disk target"}
        value={episode ? `${episode} · ${targetTitle}` : targetTitle}
        detail={targetHere ? "this session" : targetWork || "target pending"}
        active={targetHere}
      />
    </div>
  );
}

function RouteNode({ label, value, detail, active }: { label: string; value: string; detail: string; active: boolean }) {
  return (
    <div className={cn("min-w-0 rounded-lg border bg-muted/20 px-3 py-2.5", active && "border-primary/25 bg-primary/[.06]")}>
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-[8px] uppercase tracking-[0.15em] text-muted-foreground">{label}</p>
        {active && <span className="size-1.5 rounded-full bg-primary" title="Current session" />}
      </div>
      <p className="mt-1.5 truncate text-xs font-medium text-foreground" title={value}>{value}</p>
      <p className="mt-0.5 truncate font-mono text-[8px] uppercase tracking-wider text-muted-foreground/75">{detail}</p>
    </div>
  );
}

function JobProgressPanel({
  eyebrow,
  value,
  detail,
  percent: progress,
  barClassName,
  ariaLabel,
  footnote,
  active = false,
}: {
  eyebrow: string;
  value: string;
  detail: string;
  percent: number;
  barClassName: string;
  ariaLabel: string;
  footnote: string;
  active?: boolean;
}) {
  return (
    <div className="min-w-0 bg-card px-4 py-4 sm:px-5">
      <p className="font-mono text-[8px] uppercase tracking-[0.16em] text-muted-foreground">{eyebrow}</p>
      <p className="mt-2 truncate font-mono text-lg font-medium tabular-nums text-foreground" title={value}>{value}</p>
      <p className="mt-0.5 truncate text-[10px] text-muted-foreground" title={detail}>{detail}</p>
      <div
        className="relative mt-3 h-2 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={ariaLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress)}
      >
        <div className={cn("absolute inset-y-0 left-0 rounded-full transition-[width] duration-700", barClassName)} style={{ width: `${progress}%` }} />
        {active && <div className="absolute inset-0 animate-pulse bg-gradient-to-r from-transparent via-white/25 to-transparent" />}
      </div>
      <p className="mt-2 text-[9px] leading-4 text-muted-foreground/75">{footnote}</p>
    </div>
  );
}

function JobStateBadge({ state }: { state: string }) {
  return (
    <span className={cn(
      "rounded-full border px-2 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-[0.14em]",
      state === "completed" && "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      ["downloading", "resolving"].includes(state) && "border-primary/25 bg-primary/10 text-primary",
      state === "queued" && "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300",
      ["failed", "cancelled"].includes(state) && "border-rose-500/25 bg-rose-500/10 text-rose-700 dark:text-rose-300",
      state === "skipped" && "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    )}>
      {state}
    </span>
  );
}

function watchSnapshotDetail(job: PreDownloadJobResponse): string {
  const triggerThreshold = job.triggerThreshold ?? 0;
  const threshold = job.triggerUnit === "percent"
    ? `${formatPercent(triggerThreshold)} watch threshold`
    : `${formatNumber(triggerThreshold)}s playback threshold`;
  if ((job.watchDurationTicks ?? 0) > 0) {
    return `${formatTicks(job.watchPositionTicks)} of ${formatTicks(job.watchDurationTicks)} · ${threshold}`;
  }
  return `${formatTicks(job.watchPositionTicks)} reported · ${threshold}`;
}

function watchThresholdPercent(job: PreDownloadJobResponse): number {
  const triggerThreshold = job.triggerThreshold ?? 0;
  if (job.triggerUnit === "percent") return clampedPercent(triggerThreshold);
  if (triggerThreshold <= 0) return 100;
  return clampedPercent(((job.watchPositionTicks ?? 0) / 10_000_000) * 100 / triggerThreshold);
}

function downloadProgressValue(job: PreDownloadJobResponse, progress: number): string {
  if (job.state === "resolving") return "Resolving target";
  if (job.state === "queued") return "Waiting in queue";
  return `${formatPercent(progress)} on disk`;
}

function downloadProgressDetail(job: PreDownloadJobResponse): string {
  if ((job.totalBytes ?? 0) <= 0) return "No target bytes allocated yet";
  return `${formatBytes(job.bytesDownloaded)} of ${formatBytes(job.totalBytes)}`;
}

function episodeCode(season?: number | null, episode?: number | null): string | null {
  if (season == null || episode == null) return null;
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

function outcomeFallback(state: string): string {
  if (state === "skipped") return "The job was skipped without affecting playback.";
  if (state === "cancelled") return "The background download was cancelled.";
  return "The background download failed; normal remote playback remains available.";
}

function clampedPercent(value?: number | null): number {
  return Math.max(0, Math.min(100, value ?? 0));
}

function formatPercent(value: number): string {
  return `${value.toFixed(value > 0 && value < 10 ? 1 : 0)}%`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

interface ArticleMapQueryState {
  data?: ArticleMapResponse;
  isLoading: boolean;
  isError: boolean;
  isFetching?: boolean;
  error: unknown;
}

function ArticleMapPanel({ state }: { state: ArticleMapQueryState }) {
  if (state.data) {
    return (
      <div>
        {state.isError && (
          <div className="flex items-start gap-2 border-y border-amber-500/25 bg-amber-500/10 px-4 py-3 text-xs text-amber-900 dark:text-amber-200 sm:px-6 lg:px-8" role="status">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <p>
              Live article sampling failed. The last snapshot from {formatTimestamp(state.data.updatedAt)} remains visible: {errorMessage(state.error)}
            </p>
          </div>
        )}
        <ArticleMap data={state.data} />
      </div>
    );
  }

  if (state.isLoading) {
    return (
      <section className="border-y p-4 sm:p-6 lg:p-8" aria-label="Loading article flight map">
        <div className="h-72 animate-pulse rounded-xl border bg-muted/40" />
      </section>
    );
  }

  const notFound = state.error instanceof ApiError && state.error.status === 404;
  return (
    <section className="border-y bg-muted/10 px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex items-start gap-3 rounded-xl border border-dashed bg-card/70 p-4 text-sm">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Radio className="size-4" />
        </span>
        <div>
          <p className="font-medium text-foreground">
            {notFound ? "No article flight map was retained" : "Article telemetry is unavailable"}
          </p>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
            {notFound
              ? "This stream predates article-level telemetry or its short-lived diagnostic map has expired. The permanent event log below is still available."
              : errorMessage(state.error)}
          </p>
        </div>
      </div>
    </section>
  );
}

/**
 * The same "web terminal" console shell, sourced from the permanent stream-history record
 * instead of a live session — this is what makes a closed/evicted/failed stream inspectable
 * after the fact: exactly which release, when, and the full chronological event log (resolve
 * stages, folded-in PAR2 repair transitions, session lifecycle, errors).
 */
function HistoricalStreamConsole({
  record,
  articleMap,
  preDownloads,
}: {
  record: StreamRecordResponse;
  articleMap: ArticleMapQueryState;
  preDownloads: PreDownloadQueryState;
}) {
  const title = record.title || record.releaseId || "Untitled stream";
  const requester = record.requestedByName || record.requestedById || "Unattributed request";
  const createdMs = Date.parse(record.createdAt);
  const closedMs = record.closedAt ? Date.parse(record.closedAt) : null;
  const durationSeconds =
    closedMs != null && !Number.isNaN(createdMs) ? Math.max(0, (closedMs - createdMs) / 1_000) : null;

  return (
    <div className="stream-console relative isolate overflow-hidden rounded-[1.35rem] border bg-card text-card-foreground shadow-[0_22px_65px_-42px_rgba(15,23,42,.35)] dark:shadow-[0_24px_75px_-44px_rgba(0,0,0,.9)]">
      <ConsoleBackdrop />

      <header className="relative border-b bg-muted/20 px-4 py-4 dark:bg-muted/10 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-center gap-3">
          <Button asChild variant="ghost" size="sm" className="-ml-2 text-muted-foreground hover:bg-muted hover:text-foreground">
            <Link to="/sessions"><ArrowLeft />All streams</Link>
          </Button>
          <span className="hidden h-4 w-px bg-border sm:block" />
          <span className="flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            <span className="size-2 rounded-full bg-muted-foreground/50" />
            retained history
          </span>
          <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">
            permanent stream console
          </span>
        </div>
      </header>

      <main className="relative">
        <section className="border-b px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
          <div className="max-w-4xl">
            <div className="flex items-center gap-3 font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-primary">
              <span className="h-px w-10 bg-primary/70" />
              Stream telemetry / {record.client || "unknown source"}
            </div>
            <div className="mt-5 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div className="min-w-0">
                <h2 className="max-w-3xl break-words text-2xl font-semibold leading-tight tracking-[-0.035em] text-foreground sm:text-3xl lg:text-[2.5rem]">
                  {title}
                </h2>
                <p className="mt-2 truncate font-mono text-[11px] text-muted-foreground">{record.releaseId}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <FinalStateBadge state={record.finalState} />
                <span className="rounded-full border bg-background/60 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  {record.container || "stream"}
                </span>
              </div>
            </div>
          </div>
        </section>

        <StreamLogPanel token={record.token || ""} />

        <PreDownloadDiagnostics sessionToken={record.token || ""} state={preDownloads} />

        <ArticleMapPanel state={articleMap} />

        <section className="grid grid-cols-2 border-b md:grid-cols-4">
          <MetricCell
            icon={<Radio />}
            label="Bytes served"
            value={formatBytes(record.bytesServed)}
            detail={record.sizeBytes ? `of ${formatBytes(record.sizeBytes)} payload` : "total delivered"}
          />
          <MetricCell
            icon={<Network />}
            label="NNTP commands"
            value={(record.nntpCommandsTotal ?? 0).toLocaleString()}
            detail="issued over the stream's life"
          />
          <MetricCell
            icon={<Clock3 />}
            label="Duration"
            value={durationSeconds == null ? "still open" : formatDuration(durationSeconds)}
            detail="created → closed"
          />
          <MetricCell
            icon={<AlertTriangle />}
            label="Close reason"
            value={record.closeReason || "—"}
            detail={record.finalState ?? "open"}
          />
        </section>

        <TtffFlamegraph spans={record.timeline ?? []} />

        <section className="grid min-w-0 grid-cols-1 xl:grid-cols-[minmax(0,1.18fr)_minmax(23rem,.82fr)]">
          <div className="min-w-0 border-b p-4 sm:p-6 lg:p-8 xl:border-b-0 xl:border-r">
            <SectionHeading
              icon={<Terminal />}
              eyebrow="Event log"
              title="What happened, in order"
              detail="Resolve stages, folded-in PAR2 repair transitions, session lifecycle, and errors — the exact console the request said it wanted."
            />
            <EventLog events={record.events ?? []} />
          </div>

          <aside className="min-w-0 p-4 sm:p-6 lg:p-8">
            <SectionHeading
              icon={<Database />}
              eyebrow="Session ledger"
              title="Identity & lifecycle"
              detail="Exact values for correlating a support report with server logs."
            />
            <dl className="mt-7 divide-y border-y">
              <LedgerRow label="Created" value={formatTimestamp(record.createdAt)} detail={timeAgo(record.createdAt)} />
              <LedgerRow
                label="Closed"
                value={record.closedAt ? formatTimestamp(record.closedAt) : "still open"}
                detail={record.closedAt ? timeAgo(record.closedAt) : "no close recorded"}
              />
              <LedgerRow
                label="Duration"
                value={durationSeconds == null ? "—" : formatDuration(durationSeconds)}
                detail="wall-clock lifetime"
              />
              <LedgerRow label="MIME route" value={mimeFor(record.container)} detail="direct byte-range delivery" />
            </dl>

            <div className="mt-7 space-y-3">
              <Identifier label="Stream token" value={record.token || "—"} secret />
              <Identifier label="Release ID" value={record.releaseId || "—"} />
              <Identifier label="Work ID" value={record.workId || "—"} />
            </div>

            <div className="mt-7 grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2">
              <DetailCell icon={<UserRound />} label="Requester" value={requester} detail={record.requestedById || "No stable user ID reported"} />
              <DetailCell icon={<MonitorPlay />} label="Originating client" value={record.client || "Unknown"} detail="Capability session source" />
            </div>
          </aside>
        </section>
      </main>
    </div>
  );
}

function FinalStateBadge({ state }: { state?: string | null }) {
  const label = state ?? "open";
  const isGood = state === "closed" || state === "purged" || state === "reused";
  const isBad = state === "dead" || state === "error" || state === "evicted" || state === "expired" || state === "invalidated";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider",
        isGood && "border-success/20 bg-success/10 text-success-foreground",
        isBad && "border-destructive/20 bg-destructive/10 text-destructive",
        !isGood && !isBad && "border-muted-foreground/20 bg-muted/40 text-muted-foreground",
      )}
    >
      {isGood ? <ShieldCheck className="size-3" /> : isBad ? <AlertTriangle className="size-3" /> : <Clock3 className="size-3" />}
      {label}
    </span>
  );
}

function EventLog({ events }: { events: StreamEventResponse[] }) {
  if (!events.length) {
    return (
      <div className="mt-7 flex min-h-28 items-center justify-center rounded-xl border border-dashed px-6 text-center font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
        No diagnostic events were recorded for this stream
      </div>
    );
  }
  return (
    <ol className="mt-7 space-y-1.5">
      {events.map((event, index) => (
        <li
          key={`${event.atUtc}-${index}`}
          className="flex items-start gap-3 rounded-lg border bg-muted/15 px-3 py-2.5 text-xs transition-colors hover:bg-muted/30"
        >
          <span className={cn("mt-1 size-1.5 shrink-0 rounded-full", eventSourceDot(event.source))} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                {event.source}/{event.category}
              </span>
              <span className="font-medium text-foreground">{event.name}</span>
              {event.durationMs != null && (
                <span className="font-mono text-[9px] text-muted-foreground/70">{formatMs(event.durationMs)}</span>
              )}
            </div>
            {event.detail && (
              <p className="mt-0.5 truncate text-muted-foreground" title={event.detail}>
                {event.detail}
              </p>
            )}
          </div>
          <span className="shrink-0 font-mono text-[9px] text-muted-foreground/70">{formatTimestamp(event.atUtc)}</span>
        </li>
      ))}
    </ol>
  );
}

function eventSourceDot(source?: string | null) {
  switch (source) {
    case "ttff":
      return "bg-primary";
    case "repair":
      return "bg-amber-500";
    case "error":
      return "bg-rose-500";
    default:
      return "bg-slate-400"; // lifecycle
  }
}

function ConsoleBackdrop() {
  return (
    <>
      <div
        className="pointer-events-none absolute inset-0 -z-10 opacity-50"
        style={{
          backgroundImage: "linear-gradient(hsl(var(--primary) / .055) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--primary) / .055) 1px, transparent 1px)",
          backgroundSize: "28px 28px",
          maskImage: "linear-gradient(to bottom, black, transparent 42%)",
        }}
      />
      <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-80 bg-[radial-gradient(ellipse_at_top_right,hsl(var(--primary)/.11),transparent_64%)]" />
    </>
  );
}

function LiveIndicator({ fetching }: { fetching: boolean }) {
  return (
    <span className="flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-success-foreground">
      <span className="relative flex size-2">
        <span className={cn("absolute inline-flex size-full rounded-full bg-success opacity-40", fetching && "animate-ping")} />
        <span className="relative inline-flex size-2 rounded-full bg-success" />
      </span>
      {fetching ? "sampling" : "live signal"}
    </span>
  );
}

function StatusBadge({ state }: { state?: string | null }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-success/20 bg-success/10 px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-success-foreground">
      <ShieldCheck className="size-3" /> {state || "ready"}
    </span>
  );
}

function SegmentRail({ percent: value, cachedPercent }: { percent: number; cachedPercent: number }) {
  return (
    <div className="grid h-7 grid-cols-[repeat(48,minmax(0,1fr))] gap-1 rounded-lg border bg-muted/30 p-1.5" aria-label={`${value.toFixed(1)} percent delivered`}>
      {Array.from({ length: 48 }, (_, index) => {
        const marker = ((index + 1) / 48) * 100;
        return (
          <span
            key={index}
            className={cn(
              "rounded-[2px] bg-muted-foreground/15 transition-colors duration-700",
              marker <= cachedPercent && "border border-primary/35",
              marker <= value && "border-transparent bg-primary",
            )}
          />
        );
      })}
    </div>
  );
}

function useTransferRate(session?: SessionResponse) {
  const [samples, setSamples] = useState<RateSample[]>([]);
  const previous = useRef<{ at: number; bytes: number } | null>(null);
  const bytes = session?.bytesServed ?? 0;
  const token = session?.token;

  useEffect(() => {
    const at = performance.now();
    if (!previous.current || !token) {
      previous.current = token ? { at, bytes } : null;
      return;
    }
    const elapsed = (at - previous.current.at) / 1_000;
    const delta = Math.max(0, bytes - previous.current.bytes);
    if (elapsed > 0.25) {
      setSamples((current) => [...current.slice(-29), { index: (current.at(-1)?.index ?? 0) + 1, rate: delta / elapsed }]);
      previous.current = { at, bytes };
    }
  }, [bytes, token]);

  return samples;
}

function RateChart({ samples }: { samples: RateSample[] }) {
  const data = samples.length > 1
    ? samples
    : samples.length === 1
      ? [{ index: 0, rate: samples[0].rate }, samples[0]]
      : [{ index: 0, rate: 0 }, { index: 1, rate: 0 }];
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 8, right: 2, bottom: 0, left: -22 }}>
        <defs>
          <linearGradient id="stream-rate-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.24} />
            <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 5" vertical={false} />
        <XAxis dataKey="index" hide />
        <YAxis tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))", fontFamily: "monospace" }} tickLine={false} axisLine={false} tickFormatter={(rate) => formatRateCompact(Number(rate))} />
        <Tooltip
          cursor={{ stroke: "hsl(var(--muted-foreground))", strokeDasharray: "3 3" }}
          contentStyle={{ background: "hsl(var(--card))", color: "hsl(var(--card-foreground))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontFamily: "monospace", fontSize: 11 }}
          labelStyle={{ display: "none" }}
          formatter={(rate: number) => [formatRate(rate), "rate"]}
        />
        <Area type="monotone" dataKey="rate" stroke="hsl(var(--primary))" strokeWidth={1.5} fill="url(#stream-rate-fill)" isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function MiniMetric({ label, value, className }: { label: string; value: string; className?: string }) {
  return <div className={className}><p className="text-[9px] uppercase tracking-wider text-muted-foreground/75">{label}</p><p className="mt-1 truncate text-xs text-foreground">{value}</p></div>;
}

function MetricCell({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail: string }) {
  return (
    <div className="min-w-0 p-4 even:border-l md:border-l md:first:border-l-0 sm:p-5 lg:px-8">
      <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground [&_svg]:size-3.5 [&_svg]:text-primary">{icon}{label}</div>
      <p className="mt-2 truncate font-mono text-xl font-medium tabular-nums text-foreground">{value}</p>
      <p className="mt-1 truncate text-[11px] text-muted-foreground/80">{detail}</p>
    </div>
  );
}

function SectionHeading({ icon, eyebrow, title, detail }: { icon: React.ReactNode; eyebrow: string; title: string; detail: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/35 text-primary [&_svg]:size-4">{icon}</span>
      <div>
        <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground/75">{eyebrow}</p>
        <h3 className="mt-1 font-semibold tracking-tight text-foreground">{title}</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

function DataPath({ client, connections, globalConnections, connectionBudget, cachedChunks, providers }: {
  client: string;
  connections: number;
  globalConnections: number;
  connectionBudget: number;
  cachedChunks: number;
  providers: Array<{ name: string | null; tripped?: boolean; activeConnections?: number }>;
}) {
  const providerLabel = providers.length ? `${providers.filter((provider) => !provider.tripped).length}/${providers.length} providers ready` : "provider pool";
  const nodes = [
    { icon: <MonitorPlay />, label: "Client", value: client, detail: "byte-range consumer" },
    { icon: <ShieldCheck />, label: "Session gate", value: "admitted", detail: "capability verified" },
    { icon: <Server />, label: "NNTP pool", value: `${connections} active`, detail: `${globalConnections}/${connectionBudget || "—"} global · ${providerLabel}` },
    { icon: <HardDrive />, label: "Segment cache", value: `${cachedChunks} resident`, detail: "decoded article chunks" },
  ];
  return (
    <div className="mt-8 grid min-w-0 grid-cols-1 gap-2 md:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] md:items-center">
      {nodes.map((node, index) => (
        <div className="contents" key={node.label}>
          <div className="min-w-0 rounded-xl border bg-muted/20 p-4 dark:bg-muted/15">
            <div className="flex items-center justify-between text-muted-foreground [&_svg]:size-4 [&_svg]:text-primary"><span className="font-mono text-[9px] uppercase tracking-wider">{node.label}</span>{node.icon}</div>
            <p className="mt-4 truncate font-mono text-sm font-medium text-foreground">{node.value}</p>
            <p className="mt-1 truncate text-[10px] text-muted-foreground/80">{node.detail}</p>
          </div>
          {index < nodes.length - 1 && (
            <span className="flex h-5 items-center justify-center text-primary/60 md:h-auto md:w-5">
              <ArrowRight className="size-3.5 rotate-90 md:rotate-0" />
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function DetailCell({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail: string }) {
  return (
    <div className="min-w-0 bg-card p-4 sm:p-5">
      <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-wider text-muted-foreground [&_svg]:size-3.5 [&_svg]:text-primary">{icon}{label}</div>
      <p className="mt-3 truncate font-mono text-sm text-foreground" title={value}>{value}</p>
      <p className="mt-1 truncate text-[10px] text-muted-foreground/80">{detail}</p>
    </div>
  );
}

function LedgerRow({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 py-3 font-mono text-[11px]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right"><span className="block truncate text-foreground">{value}</span><span className="block text-[9px] uppercase tracking-wider text-muted-foreground/70">{detail}</span></dd>
    </div>
  );
}

function Identifier({ label, value, secret = false }: { label: string; value: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }
  const display = secret && value.length > 24 ? `${value.slice(0, 12)}••••••••${value.slice(-8)}` : value;
  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="font-mono text-[9px] uppercase tracking-[0.15em] text-muted-foreground">{label}</p>
        <button type="button" onClick={copy} className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-primary active:translate-y-px" aria-label={`Copy ${label}`}>
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
      </div>
      <p className="mt-2 break-all font-mono text-[10px] leading-5 text-muted-foreground">{display}</p>
    </div>
  );
}

function EventTimeline({ events }: { events: StreamingHistoryResponse[] }) {
  if (!events.length) {
    return (
      <div className="mt-7 flex min-h-28 items-center justify-center rounded-xl border border-dashed px-6 text-center font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
        No correlated playback events have arrived for this stream
      </div>
    );
  }
  return (
    <ol className="mt-7 grid gap-2 lg:grid-cols-3">
      {events.slice(0, 6).map((event, index) => (
        <li key={event.id ?? `${event.event}-${index}`} className="min-w-0 rounded-xl border bg-muted/20 p-4 transition-colors hover:bg-muted/35">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-primary"><span className="size-1.5 rounded-full bg-primary" />{event.event || "progress"}</span>
            <span className="font-mono text-[9px] text-muted-foreground/70">{timeAgo(event.receivedAt)}</span>
          </div>
          <p className="mt-4 font-mono text-lg tabular-nums text-foreground">{formatTicks(event.positionTicks)}</p>
          <p className="mt-1 truncate text-[10px] text-muted-foreground">{event.externalUserName || event.source} / {event.deviceName || "unknown device"}</p>
        </li>
      ))}
    </ol>
  );
}

function StreamStatsSkeleton() {
  return (
    <div className="overflow-hidden rounded-[1.35rem] border bg-card p-5 sm:p-8" aria-label="Loading stream telemetry">
      <div className="h-4 w-40 animate-pulse rounded bg-muted" />
      <div className="mt-12 h-10 max-w-2xl animate-pulse rounded bg-muted" />
      <div className="mt-10 h-32 animate-pulse rounded-xl bg-muted/70" />
      <div className="mt-8 grid gap-3 md:grid-cols-4">{Array.from({ length: 4 }, (_, index) => <div key={index} className="h-24 animate-pulse rounded-xl bg-muted/70" />)}</div>
    </div>
  );
}

function StreamStatsMessage({ icon, eyebrow, title, description }: { icon: React.ReactNode; eyebrow: string; title: string; description: string }) {
  return (
    <div className="flex min-h-[34rem] flex-col items-center justify-center overflow-hidden rounded-[1.35rem] border bg-card px-6 text-center text-card-foreground">
      <span className="flex size-12 items-center justify-center rounded-xl border bg-muted/30 text-primary [&_svg]:size-5">{icon}</span>
      <p className="mt-5 font-mono text-[10px] uppercase tracking-[0.2em] text-primary">{eyebrow}</p>
      <h2 className="mt-2 text-2xl font-semibold tracking-tight">{title}</h2>
      <p className="mt-2 max-w-lg text-sm leading-6 text-muted-foreground">{description}</p>
      <Button asChild variant="outline" className="mt-7 bg-transparent">
        <Link to="/sessions"><ArrowLeft />Return to live streams</Link>
      </Button>
    </div>
  );
}

const TTFF_CATEGORY: Record<string, { bar: string; dot: string; label: string }> = {
  nzb: { bar: "bg-amber-500/80", dot: "bg-amber-500", label: "NZB fetch" },
  health: { bar: "bg-sky-500/80", dot: "bg-sky-500", label: "Health STAT" },
  materialize: { bar: "bg-violet-500/80", dot: "bg-violet-500", label: "Materialize" },
  probe: { bar: "bg-emerald-500/80", dot: "bg-emerald-500", label: "ffprobe" },
  session: { bar: "bg-slate-400/80", dot: "bg-slate-400", label: "Session" },
  stream: { bar: "bg-primary/80", dot: "bg-primary", label: "Stream" },
  transcode: { bar: "bg-rose-500/80", dot: "bg-rose-500", label: "Transcode" },
  client: { bar: "bg-pink-500/80", dot: "bg-pink-500", label: "Client" },
};

function ttffCategory(category: string) {
  return TTFF_CATEGORY[category] ?? { bar: "bg-zinc-400/80", dot: "bg-zinc-400", label: category };
}

function formatMs(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`;
}

/**
 * Request → first-delivered-frame waterfall. Renders the server-side resolve stages
 * (NZB fetch, health STAT, materialize, ffprobe, session, stream first byte) plus any
 * client-reported spans (Jellyfin PlaybackInfo → first frame) as a single flamegraph so a
 * multi-minute TTFF can be attributed at a glance — in dev and in prod (BRIEF §11).
 */
function TtffFlamegraph({ spans }: { spans: TtffSpanResponse[] }) {
  if (!spans || spans.length === 0) return null;
  const ordered = [...spans].sort((a, b) => a.startMs - b.startMs || a.durationMs - b.durationMs);
  const firstFrame = ordered.reduce((max, s) => Math.max(max, s.startMs + s.durationMs), 0);
  const totalMs = Math.max(1, firstFrame);
  const categories = Array.from(new Set(ordered.map((s) => s.category ?? "other")));

  return (
    <section className="border-b px-4 py-7 sm:px-6 lg:px-8">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            <Gauge className="size-3.5 text-primary" /> Time to first frame
          </p>
          <p className="mt-2 font-mono text-3xl font-medium tabular-nums text-foreground">
            {formatMs(firstFrame)}
            <span className="ml-2 text-xs text-muted-foreground">request → first frame</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/80">
          {categories.map((category) => {
            const meta = ttffCategory(category);
            return (
              <span key={category} className="flex items-center gap-1.5">
                <span className={cn("size-1.5 rounded-full", meta.dot)} /> {meta.label}
              </span>
            );
          })}
        </div>
      </div>

      <div className="space-y-1">
        {ordered.map((span, index) => {
          const meta = ttffCategory(span.category ?? "other");
          const leftPct = Math.min(100, (span.startMs / totalMs) * 100);
          const widthPct = Math.max(0.6, Math.min(100 - leftPct, (span.durationMs / totalMs) * 100));
          const labelRight = leftPct > 55;
          return (
            <div
              key={`${span.name}-${index}`}
              className="group grid grid-cols-[9.5rem_minmax(0,1fr)] items-center gap-3"
              title={`${span.name} · ${formatMs(span.durationMs)}${span.detail ? ` · ${span.detail}` : ""}${span.source === "client" ? " · client" : ""}`}
            >
              <div className="flex items-center gap-1.5 truncate font-mono text-[11px] text-muted-foreground">
                {span.source === "client" ? (
                  <MonitorPlay className="size-3 shrink-0 text-pink-500" />
                ) : (
                  <span className={cn("size-1.5 shrink-0 rounded-full", meta.dot)} />
                )}
                <span className="truncate">{span.name}</span>
              </div>
              <div className="relative h-5 rounded bg-muted/40">
                <div
                  className={cn(
                    "absolute inset-y-0 flex items-center rounded px-1.5 transition-[filter] group-hover:brightness-110",
                    meta.bar,
                  )}
                  style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                >
                  {!labelRight && (
                    <span className="truncate font-mono text-[10px] font-medium text-white/95">
                      {formatMs(span.durationMs)}
                    </span>
                  )}
                </div>
                {labelRight && (
                  <span
                    className="absolute inset-y-0 flex items-center pr-1 font-mono text-[10px] tabular-nums text-muted-foreground"
                    style={{ right: `${Math.max(0, 100 - leftPct)}%` }}
                  >
                    {formatMs(span.durationMs)}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-2 grid grid-cols-[9.5rem_minmax(0,1fr)] gap-3">
        <span />
        <div className="flex justify-between font-mono text-[9px] uppercase tracking-wider text-muted-foreground/60">
          <span>0</span>
          <span>{formatMs(totalMs / 2)}</span>
          <span>{formatMs(totalMs)}</span>
        </div>
      </div>
    </section>
  );
}

function matchingEvents(events: StreamingHistoryResponse[], session?: SessionResponse) {
  if (!session) return [];
  return events
    .filter((event) => event.releaseId === session.releaseId || (event.workId && event.workId === session.workId))
    .sort((a, b) => Date.parse(b.receivedAt ?? "") - Date.parse(a.receivedAt ?? ""));
}

function percent(value: number, total: number) {
  if (!total || total <= 0) return 0;
  return Math.max(0, Math.min(100, (value / total) * 100));
}

function formatRate(bytesPerSecond: number) {
  return `${formatBytes(Math.max(0, bytesPerSecond))}/s`;
}

function formatRateCompact(bytesPerSecond: number) {
  if (bytesPerSecond <= 0) return "0";
  if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / 1024 / 1024).toFixed(0)}M`;
  return `${(bytesPerSecond / 1024).toFixed(0)}K`;
}

function formatDuration(seconds?: number | null) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "calculating";
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatCountdown(iso: string | undefined, now: number) {
  if (!iso) return "—";
  const seconds = (Date.parse(iso) - now) / 1_000;
  return seconds <= 0 ? "due now" : formatDuration(seconds);
}

function formatTimestamp(iso?: string) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", month: "short", day: "2-digit" }).format(date);
}

function mimeFor(container?: string | null) {
  const value = container?.toLowerCase();
  if (value === "mkv") return "video/x-matroska";
  if (value === "mp4" || value === "m4v") return "video/mp4";
  if (value === "webm") return "video/webm";
  if (value === "ts" || value === "m2ts") return "video/mp2t";
  return value ? `video/${value}` : "application/octet-stream";
}
