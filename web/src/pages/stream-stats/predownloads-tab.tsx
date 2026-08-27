import { AlertTriangle, ArrowRight, Download, Film, HardDrive } from "lucide-react";
import { errorMessage } from "@/api/client";
import type { PreDownloadJobResponse } from "@/api/types";
import { cn, formatBytes, formatTicks, timeAgo } from "@/lib/utils";
import { formatTimestamp } from "./format";
import { SectionHeading } from "./shared";

export interface PreDownloadQueryState {
  data?: PreDownloadJobResponse[];
  dataUpdatedAt: number;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  error: unknown;
}

/** The "Pre-downloads" sub screen: background materialization triggered by watch progress. */
export function PreDownloadDiagnostics({
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
    <section aria-label="Pre-download diagnostics">
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
