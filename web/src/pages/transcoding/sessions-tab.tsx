import type { ReactNode } from "react";
import { AlertTriangle, Loader2, Radio, Square } from "lucide-react";
import { toast } from "sonner";
import { errorMessage } from "@/api/client";
import { useStopTranscodeSession, useTranscodeSessions } from "@/api/queries";
import type { TranscodeSessionResponse, TranscodeStartupResponse } from "@/api/types";
import { CodeDisclosure } from "@/components/code-disclosure";
import { EmptyOpsState } from "@/components/ops-page";
import { PlanSummaryLine } from "@/components/transcode-plan";
import { Button } from "@/components/ui/button";
import { formatSpeed, jobStateMeta, shellCommand } from "@/lib/transcoding";
import { cn, formatBytes, formatMs, timeAgo } from "@/lib/utils";
import { ErrorPanel, LoadingBlock, ToneBadge } from "./shared";

export function SessionsTab() {
  const sessions = useTranscodeSessions();

  if (sessions.isLoading) return <LoadingBlock label="Loading transcode sessions" />;
  if (sessions.isError) return <ErrorPanel message={errorMessage(sessions.error)} />;
  const list = sessions.data ?? [];
  if (list.length === 0) {
    return (
      <EmptyOpsState
        icon={<Radio className="size-5" />}
        title="No live transcodes"
        description="Start the test player in the Test lab, or choose “Server transcode (HLS)” in Playback Preview. Sessions appear here with their ffmpeg job."
      />
    );
  }
  return (
    <ul className="space-y-3" aria-label="Live transcode sessions">
      {list.map((session) => <SessionCard key={session.handle} session={session} />)}
    </ul>
  );
}

function SessionCard({ session }: { session: TranscodeSessionResponse }) {
  const stop = useStopTranscodeSession();
  const job = session.job;
  const state = jobStateMeta(job);
  const headingId = `transcode-${session.handle}`;

  async function stopSession() {
    try {
      await stop.mutateAsync(session.handle ?? "");
      toast.success("Transcode session stopped.");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <li className="min-w-0 space-y-3 rounded-xl border bg-card p-4" aria-labelledby={headingId}>
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1 basis-60">
          <h3 id={headingId} className="truncate font-semibold" title={session.title ?? undefined}>{session.title}</h3>
          <p className="font-mono text-[11px] text-muted-foreground">
            {session.handle} · {session.client} · started {timeAgo(session.createdAt)} · last request {timeAgo(session.lastAccessAt)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <ToneBadge tone="muted">{session.sourceKind === "sample" ? "Test sample" : "Stream"}</ToneBadge>
          <ToneBadge tone={state.tone}>{state.label}</ToneBadge>
          <Button type="button" size="sm" variant="outline" onClick={stopSession} disabled={stop.isPending} aria-label={`Stop transcode ${session.title}`}>
            {stop.isPending ? <Loader2 className="animate-spin" /> : <Square />}Stop
          </Button>
        </div>
      </div>

      <PlanSummaryLine plan={session.plan} className="text-[13px]" />

      <SegmentTrack session={session} />

      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-3 lg:grid-cols-6">
        <Metric label="ffmpeg" value={job ? `${job.fps.toFixed(0)} fps` : "—"} detail={job ? `${formatSpeed(job.speed)} realtime` : "no running job"} />
        <Metric label="CPU" value={job ? `${job.cpuSeconds.toFixed(1)} s` : "—"} detail={job ? `${job.frames.toLocaleString()} frames` : undefined} />
        <Metric label="First segment" value={formatMs(session.timeToFirstSegmentMs)} detail={job?.timeToFirstSegmentMs != null ? `job ${formatMs(job.timeToFirstSegmentMs)}` : "served to the player"} />
        <Metric label="Served" value={formatBytes(session.bytesServed)} detail={`${session.segmentsServed} segments`} />
        <Metric label="Restarts" value={String(session.restarts)} detail="seeks outside the buffer" warn={session.restarts > 3} />
        <Metric label="Exit code" value={job?.exitCode != null ? String(job.exitCode) : "—"} detail={job?.running ? "still running" : undefined} warn={job?.exitCode != null && job.exitCode !== 0} />
      </dl>

      {session.startup && <StartupBreakdown startup={session.startup} />}

      {session.lastError && (
        <p className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-800 dark:text-red-200" role="alert">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="whitespace-pre-wrap break-words">{session.lastError}</span>
        </p>
      )}

      {job && (
        <div className="grid gap-2 lg:grid-cols-2">
          <CodeDisclosure title="ffmpeg command" text={job.command?.length ? shellCommand(job.command) : ""} meta={`from segment ${job.startSegment}`} />
          <CodeDisclosure title="ffmpeg log" text={(job.log ?? []).join("\n")} meta={`${job.log?.length ?? 0} lines`} emptyText="ffmpeg wrote no warnings." />
        </div>
      )}
    </li>
  );
}

/** Timeline of the rendition: produced range of the current ffmpeg run and the player's last request. */
function SegmentTrack({ session }: { session: TranscodeSessionResponse }) {
  const count = Math.max(1, session.segmentCount);
  const job = session.job;
  const start = job ? Math.min(job.startSegment, count) : 0;
  const front = job ? Math.min(Math.max(job.front, start), count) : 0;
  const requested = session.lastRequestedSegment;
  const describe = `${job ? `ffmpeg produced segments ${start} to ${Math.max(start, front - 1)}` : "no ffmpeg run"}; player last requested ${requested >= 0 ? `segment ${requested}` : "nothing yet"} of ${count}`;
  return (
    <div className="space-y-1">
      <div className="relative h-2.5 rounded-full bg-lime-500/15" role="img" aria-label={describe}>
        {job && front > start && (
          <div
            className={cn("absolute inset-y-0 rounded-full", job.paused ? "bg-sky-500" : "bg-lime-500")}
            style={{ left: `${(start / count) * 100}%`, width: `${((front - start) / count) * 100}%` }}
          />
        )}
        {requested >= 0 && (
          <div className="absolute -bottom-1 -top-1 w-0.5 rounded bg-foreground" style={{ left: `calc(${((requested + 0.5) / count) * 100}% - 1px)` }} />
        )}
      </div>
      <div className="flex flex-wrap justify-between gap-x-4 font-mono text-[10px] text-muted-foreground">
        <span>
          {job ? `ffmpeg front: segment ${front}` : "ffmpeg idle"} · player at {requested >= 0 ? `segment ${requested}` : "—"}
        </span>
        <span>{count} × {session.segmentLengthSeconds} s</span>
      </div>
    </div>
  );
}

function Metric({ label, value, detail, warn = false }: { label: string; value: ReactNode; detail?: string; warn?: boolean }) {
  return (
    <div className="min-w-0 bg-card px-3 py-2">
      <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{label}</dt>
      <dd className={cn("mt-0.5 truncate text-sm font-semibold", warn && "text-amber-600 dark:text-amber-400")}>{value}</dd>
      {detail && <dd className="truncate text-[10px] text-muted-foreground">{detail}</dd>}
    </div>
  );
}

/** Where the session's time to first segment went; everything before "ffmpeg" is added by the transcode path itself. */
function StartupBreakdown({ startup }: { startup: TranscodeStartupResponse }) {
  const setup = startup.capabilitiesMs + startup.probeMs + startup.planMs + startup.spawnMs;
  const ready = startup.firstSegmentReadyMs;
  const served = startup.firstSegmentServedMs;
  const parts = [
    startup.capabilitiesMs >= 1 ? `hardware detection ${formatMs(startup.capabilitiesMs)}` : null,
    `probe ${formatMs(startup.probeMs)}${startup.probeCached ? " (cached)" : ""}`,
    `ffmpeg start ${formatMs(startup.spawnMs + startup.planMs)}`,
    ready != null ? `first segment encoded ${formatMs(Math.max(0, ready - setup))}` : "first segment encoding…",
    ready != null && served != null ? `delivered ${formatMs(Math.max(0, served - ready))}` : null,
  ].filter(Boolean);
  return (
    <p className="font-mono text-[11px] leading-5 text-muted-foreground" aria-label="Startup breakdown">
      <span className="font-semibold text-foreground">Startup {served != null ? formatMs(served) : "…"}</span>
      {" = "}
      {parts.join(" + ")}
    </p>
  );
}
