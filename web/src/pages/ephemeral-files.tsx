import { type MouseEvent, useState } from "react";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowUpRight, Box, Clock3, Download, HardDrive, Loader2, Radio, ShieldCheck, Trash2, UserRound } from "lucide-react";
import { toast } from "sonner";
import { useEphemeralFiles, usePurgeEphemeralFile } from "@/api/queries";
import type { EphemeralFileResponse } from "@/api/types";
import { errorMessage } from "@/api/client";
import { EmptyOpsState, OpsHero, OpsMetric, OpsMetrics } from "@/components/ops-page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn, formatBytes, timeAgo } from "@/lib/utils";

export function EphemeralFilesPage() {
  const query = useEphemeralFiles();
  const files = query.data ?? [];
  const totalChunks = files.reduce((total, file) => total + (file.totalChunks ?? 0), 0);
  const queriedChunks = files.reduce((total, file) => total + (file.chunksQueried ?? 0), 0);
  const nextPurge = [...files].sort((a, b) => Date.parse(a.purgeAt ?? "") - Date.parse(b.purgeAt ?? ""))[0];

  return (
    <div className="space-y-5">
      <OpsHero
        eyebrow="Server-managed cache"
        title="Ephemeral files"
        description="Server-owned ephemeral file cache. Full decoded sizes count toward the configured budget, least-recently-accessed files are evicted first, and the hard expiry is never extended by playback activity."
        accent="cyan"
      >
        <OpsMetrics>
          <OpsMetric label="Retained files" value={String(files.length)} detail="stream capabilities" />
          <OpsMetric label="Cache allocation" value={formatBytes(files.reduce((n, f) => n + (f.sizeBytes ?? 0), 0))} detail="decoded file sizes" />
          <OpsMetric label="Chunks requested" value={queriedChunks.toLocaleString()} detail={`of ${totalChunks.toLocaleString()} total`} />
          <OpsMetric label="Next expiry" value={nextPurge?.purgeAt ? timeUntil(nextPurge.purgeAt) : "—"} detail={nextPurge?.title ?? "no active sessions"} />
        </OpsMetrics>
      </OpsHero>

      <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
        <span className="relative flex size-2">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-cyan-400 opacity-60" />
          <span className="relative inline-flex size-2 rounded-full bg-cyan-500" />
        </span>
        Live telemetry refreshes every 3 seconds
      </div>

      {query.isLoading ? (
        <div className="space-y-3">{[0, 1, 2].map((key) => <div key={key} className="h-48 animate-pulse rounded-2xl bg-muted" />)}</div>
      ) : query.isError ? (
        <div className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive"><AlertTriangle className="size-4" />{errorMessage(query.error)}</div>
      ) : files.length === 0 ? (
        <EmptyOpsState
          icon={<Radio className="size-5" />}
          title="The ephemeral cache is empty"
          description="Open a release in Jellyfin or Playback Preview. Its requester, decoded-size allocation, chunk footprint, LRU access, and hard expiry will remain visible until Core evicts it."
        />
      ) : (
        <div className="space-y-3">
          {files.map((file) => <EphemeralRow key={file.token ?? file.releaseId ?? "ephemeral"} file={file} />)}
        </div>
      )}
    </div>
  );
}

function EphemeralRow({ file }: { file: EphemeralFileResponse }) {
  const requestFootprintPercent = Math.max(0, Math.min(100, file.estimatedStreamedPercent ?? 0));
  const preDownloadPercent = Math.max(0, Math.min(100, file.preDownloadPercent ?? 0));
  const retentionPriority = file.retentionPriority || "normal";
  const hasPreDownload = retentionPriority === "background"
    || Boolean(file.preDownloadJobId || file.preDownloadReason || file.preDownloadState || file.localCacheReady)
    || (file.preDownloadedBytes ?? 0) > 0;
  const requester = file.requestedByName || file.requestedById || "Unknown requester";

  return (
    <article className="group relative overflow-hidden rounded-2xl border bg-card shadow-sm transition-colors hover:border-cyan-500/40">
      <Link
        to="/sessions/$sessionToken"
        params={{ sessionToken: file.token ?? "" }}
        className="absolute inset-0 z-[1] rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
        aria-label={`Inspect stream ${file.title ?? file.releaseId ?? ""}`}
      />
      <div className="grid lg:grid-cols-[minmax(0,1.3fr)_minmax(25rem,1fr)]">
        <div className="min-w-0 p-5 sm:p-6">
          <div className="flex items-start gap-4">
            <div className="relative flex size-11 shrink-0 items-center justify-center rounded-xl border bg-cyan-500/10 text-cyan-600 dark:text-cyan-400">
              <Box className="size-5" />
              <span className="absolute -right-1 -top-1 size-2.5 rounded-full border-2 border-card bg-cyan-500" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="truncate text-base font-semibold tracking-tight" title={file.title ?? undefined}>{file.title ?? "Untitled release"}</h3>
                <Badge variant="success" className="uppercase">{file.state ?? "ready"}</Badge>
                {file.container && <Badge variant="outline" className="font-mono uppercase">{file.container}</Badge>}
                <Badge
                  variant="outline"
                  className={cn(
                    "gap-1 font-mono text-[9px] uppercase tracking-wider",
                    retentionPriority === "background" && "border-primary/25 bg-primary/10 text-primary",
                  )}
                >
                  <ShieldCheck className="size-3" /> {retentionPriority} retention
                </Badge>
                <ArrowUpRight className="hidden size-4 text-muted-foreground opacity-40 transition-all group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-cyan-500 group-hover:opacity-100 sm:block" />
              </div>
              <p className="mt-1 truncate text-xs text-muted-foreground" title={file.fileName ?? undefined}>{file.fileName}</p>
            </div>
            <PurgeControl file={file} />
          </div>

          {hasPreDownload && (
            <PreDownloadFileProgress file={file} percent={preDownloadPercent} />
          )}

          <div className="mt-6">
            <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Playback request footprint</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{requestFootprintPercent.toFixed(requestFootprintPercent < 10 ? 1 : 0)}%</p>
              </div>
              <p className="font-mono text-xs text-muted-foreground sm:text-right">
                {(file.chunksQueried ?? 0).toLocaleString()} / {(file.totalChunks ?? 0).toLocaleString()} unique chunks touched
              </p>
            </div>
            <div
              className="relative h-3 overflow-hidden rounded-full border bg-muted/70"
              role="progressbar"
              aria-label="Playback segment request footprint"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(requestFootprintPercent)}
            >
              <div className="absolute inset-y-0 left-0 rounded-full bg-cyan-500 transition-[width] duration-700" style={{ width: `${requestFootprintPercent}%` }} />
              <div className="absolute inset-0 opacity-25" style={{ backgroundImage: "repeating-linear-gradient(90deg,transparent 0,transparent 11px,currentColor 12px,currentColor 13px)" }} />
            </div>
            <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
              Unique media chunks requested by playback or probing; this is neither watch progress nor disk pre-download completion.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-px border-t bg-border lg:border-l lg:border-t-0">
          <Cell icon={<UserRound />} label="Requested by" value={requester} detail={file.client ?? "unknown client"} />
          <Cell icon={<ShieldCheck />} label="Retention" value={retentionPriority} detail={retentionPriority === "background" ? "implicit files evict first" : "explicit playback priority"} />
          <Cell icon={<HardDrive />} label="Segment cache" value={formatBytes(file.storageBytes)} detail={`${(file.cachedChunks ?? 0).toLocaleString()} chunks resident`} />
          <Cell icon={<Radio />} label="Bytes served" value={formatBytes(file.bytesServed)} detail={`of ${formatBytes(file.sizeBytes)}`} />
          {hasPreDownload && (
            <Cell
              icon={<Download />}
              label="Disk pre-download"
              value={`${preDownloadPercent.toFixed(preDownloadPercent > 0 && preDownloadPercent < 10 ? 1 : 0)}%`}
              detail={`${formatBytes(file.preDownloadedBytes)} of ${formatBytes(file.preDownloadTotalBytes)}`}
            />
          )}
          <Cell icon={<Clock3 />} label="Hard expiry" value={file.purgeAt ? timeUntil(file.purgeAt) : "—"} detail={`LRU touch ${timeAgo(file.lastAccessedAt)}`} />
        </div>
      </div>
      <div className="flex flex-col gap-1 border-t bg-muted/25 px-5 py-2.5 font-mono text-[10px] text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <span className="truncate">work / {file.workId}</span>
        <span className="truncate">release / {file.releaseId}</span>
      </div>
    </article>
  );
}

function PreDownloadFileProgress({ file, percent }: { file: EphemeralFileResponse; percent: number }) {
  const state = file.preDownloadState || (file.localCacheReady ? "completed" : "queued");
  return (
    <div className="mt-6 min-w-0 rounded-xl border border-primary/20 bg-primary/[.045] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Download className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground">Ephemeral disk file</p>
            <p className="mt-1 text-sm font-medium text-foreground">
              {file.localCacheReady ? "Local playback copy is ready" : "Background file materialization"}
            </p>
          </div>
        </div>
        <span className={cn(
          "rounded-full border px-2 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-[0.14em]",
          state === "completed" && "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
          state === "downloading" && "border-primary/25 bg-primary/10 text-primary",
          ["failed", "cancelled"].includes(state) && "border-rose-500/25 bg-rose-500/10 text-rose-700 dark:text-rose-300",
          !["completed", "downloading", "failed", "cancelled"].includes(state) && "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        )}>
          {state}
        </span>
      </div>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-x-3 gap-y-1 font-mono">
        <p className="text-xl font-semibold tabular-nums text-foreground">
          {percent.toFixed(percent > 0 && percent < 10 ? 1 : 0)}%
        </p>
        <p className="min-w-0 text-right text-[10px] text-muted-foreground">
          {formatBytes(file.preDownloadedBytes)} / {formatBytes(file.preDownloadTotalBytes)} on disk
        </p>
      </div>
      <div
        className="relative mt-2 h-2 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label="Ephemeral disk pre-download progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
      >
        <div className={cn("absolute inset-y-0 left-0 rounded-full transition-[width] duration-700", state === "completed" ? "bg-emerald-500" : "bg-primary")} style={{ width: `${percent}%` }} />
        {state === "downloading" && <div className="absolute inset-0 animate-pulse bg-gradient-to-r from-transparent via-white/25 to-transparent" />}
      </div>
      <p className="mt-3 text-[10px] leading-4 text-muted-foreground">
        <span className="font-medium text-foreground">Why:</span> {file.preDownloadReason || "Prepared by the low-priority pre-download policy."}
      </p>
    </div>
  );
}

/**
 * Manual cache reclaim for one ephemeral file. Sits above the card's inspect overlay (z-[2])
 * and swallows the click so purging never navigates to the stream page. Actively streamed files
 * render a disabled control — the server also refuses them, so this only mirrors that guard in the
 * UI rather than enforcing it.
 */
function PurgeControl({ file }: { file: EphemeralFileResponse }) {
  const purge = usePurgeEphemeralFile();
  const [confirming, setConfirming] = useState(false);

  const swallow = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  async function onPurge(event: MouseEvent) {
    swallow(event);
    if (!file.token) return;
    try {
      await purge.mutateAsync(file.token);
      toast.success("Ephemeral file purged.");
    } catch (err) {
      toast.error(errorMessage(err));
      setConfirming(false);
    }
  }

  if (file.isStreaming) {
    return (
      <div className="relative z-[2] shrink-0">
        <Button size="sm" variant="outline" disabled title="Actively streaming — cannot be purged">
          <Radio className="size-4" />
          Streaming
        </Button>
      </div>
    );
  }

  return (
    <div className="relative z-[2] flex shrink-0 items-center gap-1">
      {confirming ? (
        <>
          <Button size="sm" variant="destructive" onClick={onPurge} disabled={purge.isPending}>
            {purge.isPending ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            Confirm
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={(event) => {
              swallow(event);
              setConfirming(false);
            }}
            disabled={purge.isPending}
          >
            Cancel
          </Button>
        </>
      ) : (
        <Button
          size="sm"
          variant="outline"
          onClick={(event) => {
            swallow(event);
            setConfirming(true);
          }}
          aria-label={`Purge ephemeral file ${file.title ?? file.releaseId ?? ""}`}
        >
          <Trash2 className="size-4" />
          Purge
        </Button>
      )}
    </div>
  );
}

function Cell({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail: string }) {
  return (
    <div className="min-w-0 bg-card p-4">
      <div className="flex items-center gap-1.5 text-muted-foreground [&_svg]:size-3.5"><span>{icon}</span><span className="font-mono text-[10px] uppercase tracking-wider">{label}</span></div>
      <p className="mt-2 truncate text-sm font-semibold tabular-nums" title={value}>{value}</p>
      <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{detail}</p>
    </div>
  );
}

function timeUntil(iso: string): string {
  const milliseconds = Date.parse(iso) - Date.now();
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "due now";
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `in ${hours}h ${rest}m` : `in ${hours}h`;
}
