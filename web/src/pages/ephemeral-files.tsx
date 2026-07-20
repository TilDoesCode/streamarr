import { Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowUpRight, Box, Clock3, HardDrive, Radio, UserRound } from "lucide-react";
import { useEphemeralFiles } from "@/api/queries";
import type { EphemeralFileResponse } from "@/api/types";
import { errorMessage } from "@/api/client";
import { EmptyOpsState, OpsHero, OpsMetric, OpsMetrics } from "@/components/ops-page";
import { Badge } from "@/components/ui/badge";
import { formatBytes, timeAgo } from "@/lib/utils";

export function EphemeralFilesPage() {
  const query = useEphemeralFiles();
  const files = query.data ?? [];
  const totalChunks = files.reduce((total, file) => total + (file.totalChunks ?? 0), 0);
  const queriedChunks = files.reduce((total, file) => total + (file.chunksQueried ?? 0), 0);
  const nextPurge = [...files].sort((a, b) => Date.parse(a.purgeAt ?? "") - Date.parse(b.purgeAt ?? ""))[0];

  return (
    <div className="space-y-5">
      <OpsHero
        eyebrow="Active stream sessions"
        title="Ephemeral files"
        description="Shows the requesting client and user for each active file, unique NZB chunks requested, chunks still held in the segment cache, bytes served, and expiry calculated from the sliding session TTL."
        accent="cyan"
      >
        <OpsMetrics>
          <OpsMetric label="Active files" value={String(files.length)} detail="live sessions" />
          <OpsMetric label="Cached bytes" value={formatBytes(files.reduce((n, f) => n + (f.storageBytes ?? 0), 0))} detail="resident segment data" />
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
          title="No ephemeral files are active"
          description="Open a release in Jellyfin or Playback Preview. Its requester, chunk counts, segment-cache usage, and session expiry will be shown here while the capability session remains active."
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
  const percent = Math.max(0, Math.min(100, file.estimatedStreamedPercent ?? 0));
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
        <div className="p-5 sm:p-6">
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
                <ArrowUpRight className="size-4 text-muted-foreground opacity-40 transition-all group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-cyan-500 group-hover:opacity-100" />
              </div>
              <p className="mt-1 truncate text-xs text-muted-foreground" title={file.fileName ?? undefined}>{file.fileName}</p>
            </div>
          </div>

          <div className="mt-6">
            <div className="mb-2 flex items-end justify-between gap-4">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Estimated stream coverage</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{percent.toFixed(percent < 10 ? 1 : 0)}%</p>
              </div>
              <p className="text-right font-mono text-xs text-muted-foreground">
                {(file.chunksQueried ?? 0).toLocaleString()} / {(file.totalChunks ?? 0).toLocaleString()} chunks queried
              </p>
            </div>
            <div className="relative h-3 overflow-hidden rounded-full border bg-muted/70">
              <div className="absolute inset-y-0 left-0 rounded-full bg-cyan-500 transition-[width] duration-700" style={{ width: `${percent}%` }} />
              <div className="absolute inset-0 opacity-25" style={{ backgroundImage: "repeating-linear-gradient(90deg,transparent 0,transparent 11px,currentColor 12px,currentColor 13px)" }} />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-px border-t bg-border lg:border-l lg:border-t-0">
          <Cell icon={<UserRound />} label="Requested by" value={requester} detail={file.client ?? "unknown client"} />
          <Cell icon={<HardDrive />} label="Storage" value={formatBytes(file.storageBytes)} detail={`${(file.cachedChunks ?? 0).toLocaleString()} chunks resident`} />
          <Cell icon={<Radio />} label="Bytes served" value={formatBytes(file.bytesServed)} detail={`of ${formatBytes(file.sizeBytes)}`} />
          <Cell icon={<Clock3 />} label="Purge clock" value={file.purgeAt ? timeUntil(file.purgeAt) : "—"} detail={`last touched ${timeAgo(file.lastAccessedAt)}`} />
        </div>
      </div>
      <div className="flex flex-col gap-1 border-t bg-muted/25 px-5 py-2.5 font-mono text-[10px] text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <span className="truncate">work / {file.workId}</span>
        <span className="truncate">release / {file.releaseId}</span>
      </div>
    </article>
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
