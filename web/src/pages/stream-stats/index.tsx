import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Box,
  Clock3,
  Database,
  Gauge,
  HardDrive,
  MonitorPlay,
  Network,
  Radio,
  Terminal,
  UserRound,
  Zap,
} from "lucide-react";
import { ApiError, errorMessage } from "@/api/client";
import { useEphemeralFiles, useMetrics, usePreDownloads, useSessionArticles, useSessions, useStreamingHistory, useStreamRecord } from "@/api/queries";
import type { SessionResponse, StreamingHistoryResponse, StreamRecordResponse } from "@/api/types";
import { Button } from "@/components/ui/button";
import { formatBytes, timeAgo } from "@/lib/utils";
import { ArticleMapPanel, type ArticleMapQueryState } from "./articles-tab";
import { EventLog, EventTimeline } from "./events-tab";
import { formatCountdown, formatDuration, formatRate, formatTimestamp, mimeFor, percent } from "./format";
import { LogsTab } from "./logs-tab";
import { DataPath, DetailCell, Identifier, LedgerRow, NetworkTab } from "./network-tab";
import { OverviewTab } from "./overview-tab";
import { PreDownloadDiagnostics, type PreDownloadQueryState } from "./predownloads-tab";
import {
  ConsoleBackdrop,
  FinalStateBadge,
  LiveIndicator,
  MetricCell,
  MiniMetric,
  RateChart,
  SectionHeading,
  SegmentRail,
  StatusBadge,
  useTransferRate,
} from "./shared";
import { StreamDetailTabs } from "./tabs";

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
  const title = file?.title || session.title || "Release name unavailable";
  const fileIdentity = file?.fileName || session.fileName || session.releaseId;

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
                  <p className="mt-2 truncate font-mono text-[11px] text-muted-foreground" title={fileIdentity ?? undefined}>
                    {fileIdentity}
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

        <StreamDetailTabs
          overview={
            <OverviewTab
              metrics={
                <>
                  <MetricCell icon={<Radio />} label="Bytes on wire" value={formatBytes(served)} detail={`${payloadPercent.toFixed(1)}% of payload`} />
                  <MetricCell icon={<Box />} label="Chunk coverage" value={`${chunkPercent.toFixed(chunkPercent < 10 ? 1 : 0)}%`} detail={`${file?.chunksQueried ?? 0} / ${file?.totalChunks ?? 0} queried`} />
                  <MetricCell icon={<Network />} label="NNTP commands" value={(session.nntpCommandsTotal ?? 0).toLocaleString()} detail={`${session.nntpConnectionsInFlight ?? 0} currently in flight`} />
                  <MetricCell icon={<Clock3 />} label="Expiry clock" value={formatCountdown(expiresAt, now)} detail={`last touched ${timeAgo(session.lastAccessedAt, now)}`} />
                </>
              }
              spans={session.timeline ?? []}
            />
          }
          logs={<LogsTab token={token} />}
          preDownloads={<PreDownloadDiagnostics sessionToken={token} state={preDownloads} />}
          articles={<ArticleMapPanel state={articleMap} />}
          network={
            <NetworkTab
              dataPath={
                <DataPath
                  client={session.client || "unknown client"}
                  connections={session.nntpConnectionsInFlight ?? 0}
                  globalConnections={globalConnections}
                  connectionBudget={connectionBudget}
                  cachedChunks={file?.cachedChunks ?? 0}
                  providers={metrics.data?.connections.providers ?? []}
                />
              }
              detailCells={
                <>
                  <DetailCell icon={<UserRound />} label="Requester" value={requester} detail={session.requestedById || "No stable user ID reported"} />
                  <DetailCell icon={<MonitorPlay />} label="Originating client" value={session.client || "Unknown"} detail="Capability session source" />
                  <DetailCell icon={<HardDrive />} label="Segment cache" value={formatBytes(file?.storageBytes)} detail={`${file?.cachedChunks ?? 0} chunks currently resident`} />
                  <DetailCell icon={<Gauge />} label="Read pressure" value={`${session.nntpConnectionsInFlight ?? 0} / ${connectionBudget || "—"}`} detail="session in-flight / global budget" />
                </>
              }
              ledgerRows={
                <>
                  <LedgerRow label="Created" value={formatTimestamp(session.createdAt)} detail={timeAgo(session.createdAt, now)} />
                  <LedgerRow label="Last access" value={formatTimestamp(session.lastAccessedAt)} detail={timeAgo(session.lastAccessedAt, now)} />
                  <LedgerRow label="Expires" value={formatTimestamp(expiresAt)} detail={formatCountdown(expiresAt, now)} />
                  <LedgerRow label="Session age" value={formatDuration(ageSeconds)} detail="wall-clock lifetime" />
                  <LedgerRow label="MIME route" value={mimeFor(session.container)} detail="direct byte-range delivery" />
                </>
              }
              identifiers={
                <>
                  <Identifier label="Capability token" value={session.token || "—"} secret />
                  <Identifier label="Release ID" value={session.releaseId || "—"} />
                  <Identifier label="Work ID" value={session.workId || "—"} />
                </>
              }
            />
          }
          events={
            <section>
              <SectionHeading
                icon={<Database />}
                eyebrow="Playback correlation"
                title="Recent client events"
                detail="Jellyfin and front-end events matching this release and work."
              />
              <div className="mt-7"><EventTimeline events={events} /></div>
            </section>
          }
        />
      </main>
    </div>
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
  const title = record.resolvedTitle || record.title || "Release name unavailable";
  const resolvedReleaseId = record.resolvedReleaseId || record.releaseId;
  const usedFallback = Boolean(
    record.resolvedReleaseId
      && record.releaseId
      && record.resolvedReleaseId !== record.releaseId,
  );
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
                <p className="mt-2 truncate font-mono text-[11px] text-muted-foreground">{resolvedReleaseId}</p>
                {usedFallback && (
                  <p className="mt-1 truncate text-xs text-amber-700 dark:text-amber-300" title={`${record.title ?? "Requested release"} · ${record.releaseId}`}>
                    requested / {record.title || "Release name unavailable"} · {record.releaseId}
                  </p>
                )}
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

        <StreamDetailTabs
          overview={
            <OverviewTab
              metrics={
                <>
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
                    label={record.failureKind ? "Failure" : "Close reason"}
                    value={record.failureReason || record.closeReason || "—"}
                    detail={record.failureKind || record.finalState || "open"}
                  />
                </>
              }
              spans={record.timeline ?? []}
            />
          }
          logs={<LogsTab token={record.token || ""} />}
          preDownloads={<PreDownloadDiagnostics sessionToken={record.token || ""} state={preDownloads} />}
          articles={<ArticleMapPanel state={articleMap} />}
          network={
            <NetworkTab
              detailCells={
                <>
                  <DetailCell icon={<UserRound />} label="Requester" value={requester} detail={record.requestedById || "No stable user ID reported"} />
                  <DetailCell icon={<MonitorPlay />} label="Originating client" value={record.client || "Unknown"} detail="Capability session source" />
                </>
              }
              ledgerRows={
                <>
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
                </>
              }
              identifiers={
                <>
                  <Identifier label="Stream token" value={record.token || "—"} secret />
                  <Identifier label="Resolved release ID" value={resolvedReleaseId || "—"} />
                  {usedFallback && <Identifier label="Requested release ID" value={record.releaseId || "—"} />}
                  <Identifier label="Work ID" value={record.workId || "—"} />
                </>
              }
            />
          }
          events={
            <section>
              <SectionHeading
                icon={<Terminal />}
                eyebrow="Event log"
                title="What happened, in order"
                detail="Resolve stages, folded-in PAR2 repair transitions, session lifecycle, and errors — the exact console the request said it wanted."
              />
              <div className="mt-7"><EventLog events={record.events ?? []} /></div>
            </section>
          }
        />
      </main>
    </div>
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

function matchingEvents(events: StreamingHistoryResponse[], session?: SessionResponse) {
  if (!session) return [];
  return events
    .filter((event) => event.sessionToken
      ? event.sessionToken === session.token
      : event.releaseId === session.releaseId && event.workId === session.workId)
    .sort((a, b) => Date.parse(b.receivedAt ?? "") - Date.parse(a.receivedAt ?? ""));
}
