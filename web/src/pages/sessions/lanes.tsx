import { useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowUpRight,
  ChevronDown,
  Clock3,
  History,
  Loader2,
  MonitorPlay,
  Trash2,
  UserRound,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { useCloseSession, usePurgeEphemeralFile } from "@/api/queries";
import { errorMessage } from "@/api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TimelineRail } from "@/components/timeline-rail";
import { cn, formatBytes, formatTicks, timeAgo } from "@/lib/utils";
import {
  formatPercent,
  formatRate,
  humanize,
  laneBufferedRanges,
  laneThroughput,
  type FailureMode,
  type LanePhase,
  type PlaybackVisit,
  type ReleaseLane,
  type StreamAttempt,
  type WatchProgress,
  type WorkGroup,
} from "./model";

const PHASE_STYLES: Record<LanePhase, { chip: string; dot: string; label: string }> = {
  failed: { chip: "border-transparent bg-destructive text-destructive-foreground", dot: "bg-destructive", label: "failed" },
  playing: { chip: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300", dot: "bg-emerald-500 motion-safe:animate-pulse", label: "playing" },
  "pre-downloading": { chip: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-300", dot: "bg-sky-500 motion-safe:animate-pulse", label: "pre-downloading" },
  downloading: { chip: "border-transparent bg-amber-500/15 text-amber-800 dark:text-amber-300", dot: "bg-amber-500 motion-safe:animate-pulse", label: "downloading" },
  idle: { chip: "border-transparent bg-muted text-muted-foreground", dot: "bg-muted-foreground/40", label: "idle" },
  completed: { chip: "border-transparent bg-muted text-muted-foreground", dot: "bg-muted-foreground/40", label: "done" },
};

const MODE_STYLES: Record<FailureMode["severity"], string> = {
  bad: "border-destructive/40 bg-destructive/10 text-destructive",
  warn: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  info: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
};

export function StreamsGroups({ groups }: { groups: WorkGroup[] }) {
  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <section key={group.key} className="overflow-hidden rounded-2xl border bg-card">
          <GroupHeader group={group} />
          <div className="divide-y border-t">
            {group.lanes.map((lane) => <LaneRow key={lane.key} lane={lane} />)}
            {group.unmatchedVisits.map((visit) => <PlaybackOnlyLane key={visit.key} visit={visit} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

function GroupHeader({ group }: { group: WorkGroup }) {
  const releases = group.lanes.length;
  return (
    <header className="flex flex-col gap-3 px-4 py-3.5 lg:flex-row lg:items-center lg:justify-between sm:px-5">
      <div className="min-w-0">
        <h2 className="truncate text-base font-semibold" title={group.title}>{group.title}</h2>
        <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground" title={group.workId}>
          work / {group.workId || "unavailable"}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {group.requester && (
            <span className="inline-flex items-center gap-1"><UserRound className="size-3" />{group.requester}</span>
          )}
          {group.device && (
            <span className="inline-flex items-center gap-1"><MonitorPlay className="size-3" />{group.device}</span>
          )}
          <Badge variant="outline" className="font-mono text-[9px] uppercase">
            {releases} {releases === 1 ? "release" : "releases"} tried
          </Badge>
        </div>
      </div>
      {group.watched && (
        <div className="w-full shrink-0 lg:w-80 xl:w-96">
          <div className="flex items-baseline justify-between gap-3 font-mono text-[10px] text-muted-foreground">
            <span className="uppercase tracking-[0.14em]">Watched · all releases</span>
            <span className="tabular-nums text-foreground">
              {formatPercent(group.watched.coverage * 100)}
              <span className="text-muted-foreground"> of {formatTicks(group.watched.durationTicks)}</span>
            </span>
          </div>
          <TimelineRail
            size="lg"
            className="mt-1.5"
            watched={group.watched.ranges}
            playhead={group.watched.playhead}
            label={`Watched ${formatPercent(group.watched.coverage * 100)} of ${group.title}, by playback time`}
          />
        </div>
      )}
    </header>
  );
}

function LaneRow({ lane }: { lane: ReleaseLane }) {
  const [expanded, setExpanded] = useState(false);
  const latest = lane.latest;
  const phase = PHASE_STYLES[lane.phase];
  const throughput = laneThroughput(latest);
  const retries = lane.attempts.length - 1;

  return (
    <article
      className={cn(
        "px-4 py-3 sm:px-5",
        lane.phase === "failed" && "bg-destructive/[.04]",
        lane.failureModes.some((mode) => mode.kind === "provider-slow") && lane.phase !== "failed" && "bg-amber-500/[.05]",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className={cn("size-2 shrink-0 rounded-full", phase.dot)} aria-hidden="true" />
        <p className="min-w-0 flex-1 basis-52 truncate font-mono text-[13px] font-medium" title={lane.title}>
          {lane.title}
        </p>
        <Badge className={cn("uppercase", phase.chip)}>
          {phase.label}{lane.phase === "failed" && latest.failureKind ? ` · ${latest.failureKind}` : ""}
          {lane.phase === "completed" && lane.phaseDetail ? ` · ${lane.phaseDetail}` : ""}
        </Badge>
        {retries > 0 && (
          <Badge variant="outline" className="font-mono text-[9px]">×{lane.attempts.length} attempts</Badge>
        )}
        <LaneActions lane={lane} />
      </div>

      {lane.failureModes.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {lane.failureModes.map((mode) => (
            <span
              key={mode.kind}
              className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px]", MODE_STYLES[mode.severity])}
              title={mode.detail}
            >
              {mode.severity !== "info" && <AlertTriangle className="size-2.5" />}
              {mode.label}{mode.detail ? ` · ${mode.detail}` : ""}
            </span>
          ))}
        </div>
      )}

      {lane.phase === "failed" && latest.failureReason && (
        <p className="mt-2 text-xs text-destructive" role="status">{latest.failureReason}</p>
      )}

      <LaneWatchedRail lane={lane} />

      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground">
        {throughput && (throughput.downloadBps != null || throughput.requiredBps != null) && (
          <span className="font-mono tabular-nums" title="Current provider ingest vs the rate this media needs for realtime playback">
            ↓ {throughput.downloadBps == null ? "idle" : formatRate(throughput.downloadBps)}
            {throughput.requiredBps != null && ` · needs ${formatRate(throughput.requiredBps)}`}
            {throughput.ratio != null && (
              <span className={cn("ml-1", throughput.ratio < 1 ? "text-amber-700 dark:text-amber-300" : "text-emerald-700 dark:text-emerald-300")}>
                {throughput.ratio.toFixed(1)}×
              </span>
            )}
          </span>
        )}
        <span className="inline-flex items-center gap-1.5">
          <MiniBar label={`Payload delivered for ${lane.title}`} percent={latest.payloadPercent} failed={lane.phase === "failed"} />
          <span className="font-mono tabular-nums">{formatPercent(latest.payloadPercent)} · {formatBytes(latest.bytesServed)} / {formatBytes(latest.sizeBytes)}</span>
        </span>
        {latest.diskPercent != null && (
          <span className="font-mono tabular-nums" title={latest.diskState}>disk {formatPercent(latest.diskPercent)}</span>
        )}
        {latest.playbackPositionTicks != null && (
          <span className="inline-flex items-center gap-1"><Clock3 className="size-3" />{formatTicks(latest.playbackPositionTicks)}</span>
        )}
        {latest.device && <span className="truncate">{latest.device}</span>}
        <span>{latest.createdAt ? timeAgo(latest.createdAt) : "time unavailable"}</span>
        {retries > 0 && (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="inline-flex items-center gap-1 font-medium text-foreground/80 hover:text-foreground"
            aria-expanded={expanded}
            aria-label={`Show earlier attempts for ${lane.title}`}
          >
            <ChevronDown className={cn("size-3 transition-transform", expanded && "rotate-180")} />
            {retries} earlier {retries === 1 ? "attempt" : "attempts"}
          </button>
        )}
      </div>

      <LaneIdentifiers lane={lane} />

      {expanded && retries > 0 && (
        <ol className="mt-3 space-y-1.5 border-l pl-3">
          {lane.attempts.slice(1).map((attempt) => <AttemptHistoryRow key={attempt.key} attempt={attempt} />)}
        </ol>
      )}
    </article>
  );
}

/**
 * The lane's slice of the work timeline: filled only where the viewer watched THROUGH THIS
 * release, with locally buffered payload as an underlay. Reading two lanes together shows
 * exactly where a release switch happened.
 */
function LaneWatchedRail({ lane }: { lane: ReleaseLane }) {
  const buffered = laneBufferedRanges(lane.latest);
  const bufferedPercent = lane.latest.live?.bufferedPercent;
  if (!lane.watched && !buffered.length) return null;
  // Mirrors the work-header rail exactly (label line above, bar below, same width),
  // so every timeline bar on the screen reads at an identical visual length.
  return (
    <div className="ml-auto mt-2.5 w-full lg:w-80 xl:w-96">
      <p className="text-right font-mono text-[10px] tabular-nums text-muted-foreground">
        {lane.watched ? `watched ${formatPercent(lane.watched.coverage * 100)}` : "not watched yet"}
        {bufferedPercent != null && ` · buffered ${formatPercent(bufferedPercent)}`}
      </p>
      <TimelineRail
        className="mt-1"
        watched={lane.watched?.ranges}
        buffered={buffered}
        playhead={lane.watched?.playhead}
        failed={lane.phase === "failed"}
        label={laneRailLabel(lane.title, lane.watched, bufferedPercent)}
      />
    </div>
  );
}

function laneRailLabel(title: string, watched?: WatchProgress, bufferedPercent?: number | null) {
  const parts = [
    watched
      ? `Watched ${formatPercent(watched.coverage * 100)} of the timeline via ${title}`
      : `No playback time recorded via ${title}`,
  ];
  if (bufferedPercent != null) parts.push(`${formatPercent(bufferedPercent)} buffered locally`);
  return parts.join(" · ");
}

function AttemptHistoryRow({ attempt }: { attempt: StreamAttempt }) {
  return (
    <li className="text-[11px] text-muted-foreground">
      <span className="font-mono tabular-nums">{attempt.createdAt ? timeAgo(attempt.createdAt) : "—"}</span>
      <span className="mx-1.5">·</span>
      <span className={cn(attempt.isFailed && "text-destructive")}>
        {attempt.isFailed ? humanize(attempt.failureKind || "failed") : attempt.state}
      </span>
      {attempt.failureReason && <span className="ml-1.5">{attempt.failureReason}</span>}
      {!attempt.isFailed && attempt.bytesServed > 0 && (
        <span className="ml-1.5 font-mono tabular-nums">{formatBytes(attempt.bytesServed)} served</span>
      )}
    </li>
  );
}

function LaneIdentifiers({ lane }: { lane: ReleaseLane }) {
  const requestedDiffers = Boolean(
    lane.requestedTitle && (lane.requestedTitle !== lane.title || lane.requestedReleaseId !== lane.releaseId),
  );
  return (
    <div className="mt-1.5 space-y-0.5 font-mono text-[10px] text-muted-foreground/80">
      {lane.releaseId && <p className="truncate" title={lane.releaseId}>release / {lane.releaseId}</p>}
      {lane.fileName && <p className="truncate" title={lane.fileName}>file / {lane.fileName}</p>}
      {requestedDiffers && (
        <p className="break-words text-amber-700 dark:text-amber-300" title={`${lane.requestedTitle} · ${lane.requestedReleaseId ?? ""}`}>
          requested / {lane.requestedTitle}{lane.requestedReleaseId ? ` · ${lane.requestedReleaseId}` : ""}
        </p>
      )}
    </div>
  );
}

export function PlaybackOnlyLane({ visit }: { visit: PlaybackVisit }) {
  return (
    <article className="px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-muted-foreground">
        <span className="size-2 shrink-0 rounded-full border border-dashed border-muted-foreground/50" aria-hidden="true" />
        <p className="min-w-0 flex-1 basis-52 truncate font-mono text-[13px]" title={visit.title}>
          {visit.title || "Release name unavailable"}
        </p>
        <Badge variant="outline">playback only</Badge>
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        No stream token was reported, so this visit is not attached to a release attempt.
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1"><UserRound className="size-3" />{visit.userName || visit.userId || "Unknown"}</span>
        <span className="inline-flex items-center gap-1"><MonitorPlay className="size-3" />{visit.device || "Unknown"}</span>
        <span className="inline-flex items-center gap-1"><Clock3 className="size-3" />{formatTicks(visit.positionTicks)}</span>
        <span className="inline-flex items-center gap-1"><History className="size-3" />{visit.eventCount} events · {visit.state}</span>
      </div>
    </article>
  );
}

export function StreamsTable({ groups }: { groups: WorkGroup[] }) {
  return (
    <div className="w-full overflow-x-auto rounded-xl border" role="region" aria-label="Streams table" tabIndex={0}>
      <table className="w-full min-w-[80rem] text-sm">
        <caption className="sr-only">Streams grouped by work and release</caption>
        <thead className="bg-muted/50 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          <tr>
            <th scope="col" className="sticky left-0 z-10 min-w-72 bg-muted px-3 py-2 text-left font-medium">Release</th>
            <th scope="col" className="px-3 py-2 text-left font-medium">Status</th>
            <th scope="col" className="px-3 py-2 text-left font-medium">Diagnosis</th>
            <th scope="col" className="px-3 py-2 text-left font-medium">Watched</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Throughput</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Payload</th>
            <th scope="col" className="px-3 py-2 text-left font-medium">Requester</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Attempts</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Started</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Actions</th>
          </tr>
        </thead>
        {groups.map((group) => (
          <tbody key={group.key}>
            <tr className="border-t bg-cyan-500/[.06]">
              <th colSpan={10} scope="rowgroup" className="px-3 py-2 text-left">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span>
                    <span className="font-medium">{group.title}</span>
                    <span className="ml-2 font-mono text-[10px] font-normal text-muted-foreground">
                      work / {group.workId || "unavailable"} · {group.lanes.length} {group.lanes.length === 1 ? "release" : "releases"}
                    </span>
                  </span>
                  {group.watched && (
                    <span className="flex w-72 items-center gap-2">
                      <TimelineRail
                        watched={group.watched.ranges}
                        playhead={group.watched.playhead}
                        label={`Watched ${formatPercent(group.watched.coverage * 100)} of ${group.title}, by playback time`}
                      />
                      <span className="font-mono text-[10px] font-normal tabular-nums text-muted-foreground">
                        {formatPercent(group.watched.coverage * 100)}
                      </span>
                    </span>
                  )}
                </div>
              </th>
            </tr>
            {group.lanes.map((lane) => <LaneTableRow key={lane.key} lane={lane} />)}
            {group.unmatchedVisits.map((visit) => <PlaybackOnlyTableRow key={visit.key} visit={visit} />)}
          </tbody>
        ))}
      </table>
    </div>
  );
}

function LaneTableRow({ lane }: { lane: ReleaseLane }) {
  const latest = lane.latest;
  const phase = PHASE_STYLES[lane.phase];
  const throughput = laneThroughput(latest);
  return (
    <tr className={cn("border-t transition-colors hover:bg-muted/25", lane.phase === "failed" && "bg-destructive/[.035]")}>
      <th scope="row" className="sticky left-0 z-[1] bg-card px-3 py-3 text-left shadow-[8px_0_12px_-12px_hsl(var(--foreground))]">
        <p className="max-w-sm truncate font-mono text-[13px] font-medium" title={lane.title}>{lane.title}</p>
        <p className="max-w-sm truncate font-mono text-[10px] font-normal text-muted-foreground" title={lane.releaseId}>{lane.releaseId || "—"}</p>
      </th>
      <td className="px-3 py-3">
        <Badge className={cn("uppercase", phase.chip)}>
          {phase.label}{lane.phase === "failed" && latest.failureKind ? ` · ${latest.failureKind}` : ""}
        </Badge>
      </td>
      <td className="px-3 py-3">
        <div className="flex max-w-64 flex-wrap gap-1">
          {lane.failureModes.map((mode) => (
            <span key={mode.kind} className={cn("inline-flex rounded-full border px-1.5 py-px font-mono text-[9px]", MODE_STYLES[mode.severity])} title={mode.detail}>
              {mode.label}
            </span>
          ))}
        </div>
        {latest.failureReason && <p className="mt-1 max-w-64 truncate text-[10px] text-destructive" title={latest.failureReason}>{latest.failureReason}</p>}
      </td>
      <td className="px-3 py-3">
        <div className="flex w-44 items-center gap-2">
          <TimelineRail
            size="sm"
            watched={lane.watched?.ranges}
            buffered={laneBufferedRanges(latest)}
            playhead={lane.watched?.playhead}
            failed={lane.phase === "failed"}
            label={laneRailLabel(lane.title, lane.watched, latest.live?.bufferedPercent)}
          />
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
            {lane.watched ? formatPercent(lane.watched.coverage * 100) : "—"}
          </span>
        </div>
      </td>
      <td className="px-3 py-3 text-right font-mono text-xs tabular-nums">
        {throughput && throughput.downloadBps != null ? formatRate(throughput.downloadBps) : "—"}
        {throughput?.requiredBps != null && (
          <p className="text-[10px] text-muted-foreground">needs {formatRate(throughput.requiredBps)}</p>
        )}
      </td>
      <td className="px-3 py-3 text-right tabular-nums">
        <p>{formatPercent(latest.payloadPercent)}</p>
        <p className="text-[10px] text-muted-foreground">{formatBytes(latest.bytesServed)} / {formatBytes(latest.sizeBytes)}</p>
      </td>
      <td className="px-3 py-3">
        <p className="max-w-40 truncate">{latest.requester}</p>
        {latest.device && <p className="max-w-40 truncate text-[10px] text-muted-foreground">{latest.device}</p>}
      </td>
      <td className="px-3 py-3 text-right font-mono tabular-nums">{lane.attempts.length}</td>
      <td className="px-3 py-3 text-right text-xs text-muted-foreground">{latest.createdAt ? timeAgo(latest.createdAt) : "—"}</td>
      <td className="px-3 py-3"><LaneActions lane={lane} align="end" /></td>
    </tr>
  );
}

function PlaybackOnlyTableRow({ visit }: { visit: PlaybackVisit }) {
  return (
    <tr className="border-t border-dashed text-muted-foreground">
      <th scope="row" className="sticky left-0 bg-card px-3 py-3 text-left font-medium">
        {visit.title || "Release name unavailable"}
        <p className="font-mono text-[10px] font-normal">playback without token</p>
      </th>
      <td className="px-3 py-3"><Badge variant="outline">{visit.state}</Badge></td>
      <td className="px-3 py-3 text-[11px]">playback only</td>
      <td className="px-3 py-3">—</td>
      <td className="px-3 py-3 text-right">—</td>
      <td className="px-3 py-3 text-right tabular-nums">{formatTicks(visit.positionTicks)}</td>
      <td className="px-3 py-3">{visit.userName || visit.userId || "Unknown"}</td>
      <td className="px-3 py-3 text-right">—</td>
      <td className="px-3 py-3 text-right text-xs">{visit.startedAt ? timeAgo(visit.startedAt) : "—"}</td>
      <td className="px-3 py-3 text-right">—</td>
    </tr>
  );
}

function LaneActions({ lane, align = "start" }: { lane: ReleaseLane; align?: "start" | "end" }) {
  const latest = lane.latest;
  const close = useCloseSession();
  const purge = usePurgeEphemeralFile();
  const [confirming, setConfirming] = useState<"close" | "purge" | null>(null);
  const pending = close.isPending || purge.isPending;

  async function confirm() {
    if (!latest.token || !confirming) return;
    try {
      if (confirming === "close") {
        await close.mutateAsync(latest.token);
        toast.success("Session closed.");
      } else {
        await purge.mutateAsync(latest.token);
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
      {latest.token && (
        <Button asChild size="sm" variant="outline">
          <Link
            to="/sessions/$sessionToken"
            params={{ sessionToken: latest.token }}
            aria-label={`Inspect stream ${lane.title}`}
          >
            <ArrowUpRight />Inspect
          </Link>
        </Button>
      )}
      {latest.isLive && latest.token && (
        <Button size="sm" variant="ghost" onClick={() => setConfirming("close")} aria-label={`Force-close session ${lane.title}`}><XCircle />Close</Button>
      )}
      {latest.file && latest.token && (
        <Button size="sm" variant="ghost" onClick={() => setConfirming("purge")} disabled={latest.file.isStreaming} title={latest.file.isStreaming ? "Actively streaming — close it before purging" : undefined} aria-label={`Purge ephemeral file ${lane.title}`}><Trash2 />Purge</Button>
      )}
    </div>
  );
}

function MiniBar({ label, percent: value, failed = false }: { label: string; percent: number; failed?: boolean }) {
  return (
    <span
      className="inline-block h-1.5 w-16 overflow-hidden rounded-full bg-muted align-middle"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
    >
      <span
        className={cn("block h-full rounded-full bg-cyan-500 transition-[width] duration-500", failed && "bg-destructive/70")}
        style={{ width: `${value}%` }}
      />
    </span>
  );
}
