import { useMemo, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowUpRight,
  Clock3,
  Database,
  Download,
  FileArchive,
  FolderOpen,
  HardDrive,
  Loader2,
  MemoryStick,
  Search,
  Trash2,
  UserRound,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import {
  cachedReleaseDownloadUrl,
  useCachedReleases,
  useEphemeralFiles,
  usePurgeEphemeralFile,
  useRemoveCachedRelease,
  useStorage,
} from "@/api/queries";
import type { CachedReleaseResponse, EphemeralFileResponse, StorageResponse } from "@/api/types";
import { errorMessage } from "@/api/client";
import { EmptyOpsState, OpsHero } from "@/components/ops-page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn, formatBytes, futureTime, timeAgo } from "@/lib/utils";

export function FilesPage() {
  const storage = useStorage();
  const files = useEphemeralFiles();
  const releases = useCachedReleases();
  const [filter, setFilter] = useState("");

  const needle = filter.trim().toLocaleLowerCase();
  const visibleFiles = useMemo(() => {
    const rows = files.data ?? [];
    if (!needle) return rows;
    return rows.filter((file) =>
      [file.title, file.fileName, file.releaseId, file.workId, file.requestedByName, file.client]
        .some((value) => value?.toLocaleLowerCase().includes(needle)));
  }, [files.data, needle]);
  const visibleReleases = useMemo(() => {
    const rows = releases.data ?? [];
    if (!needle) return rows;
    return rows.filter((release) =>
      [release.title, release.releaseId, release.workId, release.indexer]
        .some((value) => value?.toLocaleLowerCase().includes(needle)));
  }, [needle, releases.data]);

  return (
    <div className="space-y-5">
      <OpsHero
        eyebrow="Everything Streamarr keeps"
        title="Files"
        description="What is held right now and why: streamed files retained for their TTL, pre-downloads staged on disk, and the persistent NZB library — each with its since, until, and reason."
        accent="orange"
      >
        <StorageStrip
          storage={storage.data}
          loading={storage.isLoading}
          unavailable={storage.isError}
        />
      </OpsHero>

      <div className="flex flex-col gap-3 rounded-xl border bg-card p-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter title, file, indexer, requester…"
            className="pl-9"
            aria-label="Filter files"
          />
        </div>
        <span className="font-mono text-xs text-muted-foreground">
          {visibleFiles.length} on disk · {visibleReleases.length} NZBs
        </span>
      </div>

      <section aria-labelledby="ephemeral-heading" className="space-y-3">
        <SectionHeading
          id="ephemeral-heading"
          icon={<HardDrive className="size-4" />}
          title="Held right now"
          detail="Ephemeral capabilities counted against the stream-cache budget. Access refreshes LRU order; the hard TTL is never extended."
        />
        {files.isLoading ? (
          <LoadingRows count={2} />
        ) : files.isError ? (
          <ErrorState message={errorMessage(files.error)} />
        ) : visibleFiles.length === 0 ? (
          <EmptyOpsState
            icon={<HardDrive className="size-5" />}
            title={needle ? "No held files match" : "Nothing is held right now"}
            description={needle ? "Try a broader search." : "Play or pre-download a release and it will appear here with its retention window."}
          />
        ) : (
          <div className="overflow-hidden rounded-xl border bg-card">
            <ul className="divide-y">
              {visibleFiles.map((file) => <EphemeralRow key={file.token} file={file} />)}
            </ul>
          </div>
        )}
      </section>

      <section aria-labelledby="nzb-heading" className="space-y-3">
        <SectionHeading
          id="nzb-heading"
          icon={<FileArchive className="size-4" />}
          title="NZB library"
          detail="Persistent per-release NZB cache. Entries are pruned least-recently-used once the size or entry budget is exceeded."
        />
        {releases.isLoading ? (
          <LoadingRows count={2} />
        ) : releases.isError ? (
          <ErrorState message={errorMessage(releases.error)} />
        ) : visibleReleases.length === 0 ? (
          <EmptyOpsState
            icon={<FileArchive className="size-5" />}
            title={needle ? "No cached NZBs match" : "No cached releases"}
            description={needle ? "Try a broader search." : "Resolve a release from Search, Jellyfin, or Playback Preview and its NZB is stored here."}
          />
        ) : (
          <div className="overflow-hidden rounded-xl border bg-card">
            <ul className="divide-y">
              {visibleReleases.map((release) => (
                <ReleaseRow key={release.releaseId ?? "cached-release"} release={release} />
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}

function SectionHeading({ id, icon, title, detail }: { id: string; icon: ReactNode; title: string; detail: string }) {
  return (
    <div className="flex items-start gap-2.5 px-1">
      <span className="mt-0.5 text-orange-600 dark:text-orange-400">{icon}</span>
      <div>
        <h2 id={id} className="text-sm font-semibold">{title}</h2>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

function StorageStrip({
  storage,
  loading,
  unavailable,
}: {
  storage?: StorageResponse;
  loading: boolean;
  unavailable: boolean;
}) {
  const diskFree = storage?.disk.freeBytes;
  const diskLow = diskFree != null && storage != null && diskFree < (storage.disk.minimumFreeBytes ?? 0);
  return (
    <section
      className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border/80 bg-border/80 lg:grid-cols-5 dark:border-white/10 dark:bg-white/10"
      aria-label="Storage overview"
      aria-live="polite"
    >
      <StorageMetric
        icon={<HardDrive />}
        label="Disk free"
        value={unavailable ? "Unavailable" : loading ? "—" : diskFree == null ? "unknown" : formatBytes(diskFree)}
        detail={storage?.disk.totalBytes != null ? `of ${formatBytes(storage.disk.totalBytes)} · floor ${formatBytes(storage.disk.minimumFreeBytes)}` : "volume of the pre-download workspace"}
        warn={diskLow}
        loading={loading}
      />
      <StorageMetric
        icon={<Zap />}
        label="Stream cache"
        value={unavailable ? "—" : loading ? "—" : formatBytes(storage?.ephemeral.usedBytes ?? 0)}
        detail={storage ? `${storage.ephemeral.files} files · budget ${formatBytes(storage.ephemeral.budgetBytes)}` : "logical LRU budget"}
        percent={storage && (storage.ephemeral.budgetBytes ?? 0) > 0 ? (storage.ephemeral.usedBytes ?? 0) * 100 / storage.ephemeral.budgetBytes! : undefined}
        loading={loading}
      />
      <StorageMetric
        icon={<MemoryStick />}
        label="Segment cache"
        value={unavailable ? "—" : loading ? "—" : formatBytes(storage?.segmentCache.usedBytes ?? 0)}
        detail={storage ? `${(storage.segmentCache.entries ?? 0).toLocaleString()} segments in memory · ${formatBytes(storage.segmentCache.capacityBytes)} cap` : "decoded articles in memory"}
        percent={storage && (storage.segmentCache.capacityBytes ?? 0) > 0 ? (storage.segmentCache.usedBytes ?? 0) * 100 / storage.segmentCache.capacityBytes! : undefined}
        loading={loading}
      />
      <StorageMetric
        icon={<Download />}
        label="Pre-downloads"
        value={unavailable ? "—" : loading ? "—" : formatBytes(storage?.preDownload.usedBytes ?? 0)}
        detail={storage ? `${storage.preDownload.fileCount} ${storage.preDownload.fileCount === 1 ? "file" : "files"} on disk` : "materialized files on disk"}
        loading={loading}
      />
      <StorageMetric
        icon={<FolderOpen />}
        label="NZB library"
        value={unavailable ? "—" : loading ? "—" : formatBytes(storage?.nzbLibrary.usedBytes ?? 0)}
        detail={storage ? `${storage.nzbLibrary.entries} / ${storage.nzbLibrary.maxEntries} entries · budget ${formatBytes(storage.nzbLibrary.budgetBytes)}` : "persistent NZB cache"}
        percent={storage && (storage.nzbLibrary.budgetBytes ?? 0) > 0 ? (storage.nzbLibrary.usedBytes ?? 0) * 100 / storage.nzbLibrary.budgetBytes! : undefined}
        loading={loading}
      />
    </section>
  );
}

function StorageMetric({
  icon,
  label,
  value,
  detail,
  percent,
  warn = false,
  loading = false,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
  percent?: number;
  warn?: boolean;
  loading?: boolean;
}) {
  const bounded = percent == null ? null : Math.max(0, Math.min(100, percent));
  return (
    <div className="min-w-0 bg-background/75 px-3 py-3.5 sm:px-4 dark:bg-zinc-900/75" role="group" aria-label={`${label}: ${value}`}>
      <div className="flex items-center gap-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground dark:text-zinc-500 [&_svg]:size-3">
        <span className={cn("text-orange-600 dark:text-orange-400", loading && "animate-pulse")}>{icon}</span>
        <span className="truncate">{label}</span>
      </div>
      <p className={cn("mt-1 truncate text-lg font-semibold tabular-nums", warn ? "text-destructive" : "text-foreground dark:text-white", loading && "animate-pulse text-muted-foreground")} title={value}>
        {value}
      </p>
      <p className="mt-0.5 truncate text-[10px] text-muted-foreground dark:text-zinc-500" title={detail}>{detail}</p>
      {bounded != null && (
        <div
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted dark:bg-white/10"
          role="progressbar"
          aria-label={`${label} occupancy`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(bounded)}
        >
          <div
            className={cn("h-full origin-left rounded-full bg-orange-500 transition-transform duration-500", warn && "bg-destructive")}
            style={{ transform: `scaleX(${bounded / 100})` }}
          />
        </div>
      )}
    </div>
  );
}

/** Why a file exists: an explicit stream, or a pre-download (and which trigger fired it). */
export function retentionReason(file: EphemeralFileResponse): { label: string; detail?: string; preDownload: boolean } {
  const requester = file.requestedByName || file.requestedById || file.client || "unknown requester";
  if (file.preDownloadKind === "nextEpisode") {
    return { label: "Pre-download · next episode", detail: file.preDownloadReason ?? undefined, preDownload: true };
  }
  if (file.preDownloadKind === "currentFile") {
    return { label: "Pre-download · current file", detail: file.preDownloadReason ?? undefined, preDownload: true };
  }
  if (file.retentionPriority === "background") {
    return { label: "Pre-download", detail: file.preDownloadReason ?? undefined, preDownload: true };
  }
  return { label: `Stream · ${requester}`, preDownload: false };
}

function EphemeralRow({ file }: { file: EphemeralFileResponse }) {
  const purge = usePurgeEphemeralFile();
  const [confirming, setConfirming] = useState(false);
  const reason = retentionReason(file);
  const state = file.isStreaming
    ? { label: "streaming", className: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" }
    : file.preDownloadState === "downloading"
      ? { label: `${Math.round(file.preDownloadPercent ?? 0)}% on disk`, className: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-300" }
      : file.localCacheReady
        ? { label: "complete on disk", className: "border-transparent bg-muted text-muted-foreground" }
        : { label: "retained", className: "border-transparent bg-muted text-muted-foreground" };

  async function confirmPurge() {
    try {
      await purge.mutateAsync(file.token ?? "");
      toast.success("Ephemeral file purged.");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setConfirming(false);
    }
  }

  return (
    <li className="px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-0 flex-1 basis-64 truncate font-mono text-[13px] font-medium" title={file.title ?? undefined}>
          {file.title}
        </p>
        <Badge className={cn("uppercase", state.className)}>{state.label}</Badge>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px]",
            reason.preDownload
              ? "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300"
              : "border-orange-500/40 bg-orange-500/10 text-orange-700 dark:text-orange-300",
          )}
          title={reason.detail}
        >
          {reason.preDownload ? <Download className="size-2.5" /> : <UserRound className="size-2.5" />}
          {reason.label}
        </span>
        <div className="flex items-center gap-1">
          <Button asChild size="sm" variant="outline">
            <Link to="/sessions/$sessionToken" params={{ sessionToken: file.token ?? "" }} aria-label={`Inspect stream ${file.title}`}>
              <ArrowUpRight />Inspect
            </Link>
          </Button>
          {confirming ? (
            <>
              <Button size="sm" variant="destructive" onClick={confirmPurge} disabled={purge.isPending}>
                {purge.isPending && <Loader2 className="animate-spin" />}Confirm
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={purge.isPending}>Cancel</Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirming(true)}
              disabled={file.isStreaming}
              title={file.isStreaming ? "Actively streaming — close it before purging" : undefined}
              aria-label={`Purge ephemeral file ${file.title}`}
            >
              <Trash2 />Purge
            </Button>
          )}
        </div>
      </div>
      {reason.detail && (
        <p className="mt-1 text-[11px] text-muted-foreground">{reason.detail}</p>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span className="font-mono tabular-nums">{formatBytes(file.sizeBytes)}</span>
        {file.storageBytes != null && file.storageBytes > 0 && (
          <span className="font-mono tabular-nums">{formatBytes(file.storageBytes)} resident in memory</span>
        )}
        <span className="inline-flex items-center gap-1" title={absolute(file.createdAt)}>
          <Clock3 className="size-3" />since {timeAgo(file.createdAt)}
        </span>
        {file.purgeAt && (
          <span title={absolute(file.purgeAt)}>until {futureTime(file.purgeAt)}</span>
        )}
        <span title={absolute(file.lastAccessedAt)}>last touched {timeAgo(file.lastAccessedAt)}</span>
      </div>
      <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground/80" title={`${file.fileName} · ${file.releaseId}`}>
        file / {file.fileName} · release / {file.releaseId}
      </p>
    </li>
  );
}

function ReleaseRow({ release }: { release: CachedReleaseResponse }) {
  const remove = useRemoveCachedRelease();
  const [confirming, setConfirming] = useState(false);

  async function purge() {
    try {
      await remove.mutateAsync(release.releaseId ?? "");
      toast.success("Cached NZB purged.");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setConfirming(false);
    }
  }

  return (
    <li className="px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-0 flex-1 basis-64 truncate font-mono text-[13px] font-medium" title={release.title ?? undefined}>
          {release.title ?? "Untitled release"}
        </p>
        <Badge variant="outline" className="font-mono text-[10px] uppercase">{release.indexer ?? "unknown"}</Badge>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" asChild>
            <a href={cachedReleaseDownloadUrl(release.releaseId ?? "")} download aria-label={`Download NZB for ${release.title ?? "release"}`}>
              <Download />NZB
            </a>
          </Button>
          {confirming ? (
            <>
              <Button size="sm" variant="destructive" onClick={purge} disabled={remove.isPending}>
                {remove.isPending && <Loader2 className="animate-spin" />}Confirm
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={remove.isPending}>Cancel</Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirming(true)} className="text-muted-foreground hover:text-destructive" aria-label={`Purge cached NZB for ${release.title ?? "release"}`}>
              <Trash2 />Delete
            </Button>
          )}
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span className="font-mono tabular-nums">media {formatBytes(release.releaseSizeBytes)}</span>
        <span className="font-mono tabular-nums">NZB {formatBytes(release.nzbSizeBytes)}</span>
        <span className="font-mono tabular-nums">{release.fileCount ?? 0} files · {(release.segmentCount ?? 0).toLocaleString()} chunks</span>
        <span className="inline-flex items-center gap-1" title={absolute(release.cachedAt)}>
          <Database className="size-3" />added {timeAgo(release.cachedAt)}
        </span>
        <span title={absolute(release.lastAccessedAt)}>last used {timeAgo(release.lastAccessedAt)} · {release.hitCount} hits</span>
      </div>
      <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground/80" title={release.releaseId ?? undefined}>
        release / {release.releaseId}
      </p>
    </li>
  );
}

function absolute(iso?: string | null) {
  if (!iso) return undefined;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime())
    ? undefined
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(parsed);
}

function LoadingRows({ count }: { count: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: count }, (_, key) => <div key={key} className="h-24 animate-pulse rounded-xl bg-muted" />)}
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive">{message}</div>;
}
