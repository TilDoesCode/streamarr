import { useMemo, useState } from "react";
import { Archive, Database, FileArchive, Loader2, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useCachedReleases, useRemoveCachedRelease } from "@/api/queries";
import type { CachedReleaseResponse } from "@/api/types";
import { errorMessage } from "@/api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyOpsState, OpsHero, OpsMetric, OpsMetrics } from "@/components/ops-page";
import { formatBytes, timeAgo } from "@/lib/utils";

export function LibraryPage() {
  const releases = useCachedReleases();
  const [filter, setFilter] = useState("");
  const data = releases.data ?? [];
  const visible = useMemo(() => {
    const needle = filter.trim().toLocaleLowerCase();
    return needle
      ? data.filter((release) =>
          [release.title, release.releaseId, release.workId, release.indexer].some((value) =>
            value?.toLocaleLowerCase().includes(needle),
          ),
        )
      : data;
  }, [data, filter]);

  return (
    <div className="space-y-5">
      <OpsHero
        eyebrow="Persistent NZB cache"
        title="Cached releases"
        description="NZB files are cached by release ID after a successful resolve. Entries are parsed again on access and removed when the configured size or entry limit is exceeded. Source URLs and credentials are not stored."
      >
        <OpsMetrics>
          <OpsMetric label="Cached releases" value={String(data.length)} detail="entries on disk" />
          <OpsMetric label="NZB storage" value={formatBytes(sum(data, "nzbSizeBytes"))} detail="cached NZB bytes" />
          <OpsMetric label="Referenced media" value={formatBytes(sum(data, "releaseSizeBytes"))} detail="sum of release sizes" />
          <OpsMetric label="Cache reads" value={String(sum(data, "hitCount"))} detail="remote fetches avoided" />
        </OpsMetrics>
      </OpsHero>

      <div className="flex flex-col gap-3 rounded-xl border bg-card p-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter title, indexer, work or release ID…"
            className="pl-9"
            aria-label="Filter cached releases"
          />
        </div>
        <span className="font-mono text-xs text-muted-foreground">
          {visible.length.toLocaleString()} / {data.length.toLocaleString()} records
        </span>
      </div>

      {releases.isLoading ? (
        <LoadingRows />
      ) : releases.isError ? (
        <ErrorState message={errorMessage(releases.error)} />
      ) : data.length === 0 ? (
        <EmptyOpsState
          icon={<Archive className="size-5" />}
          title="No cached releases"
          description="Resolve a release from Search, Jellyfin, or Playback Preview. Core will store its NZB here until a cache limit removes it or an administrator purges it."
        />
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {visible.map((release) => (
            <ReleaseCard key={release.releaseId ?? "cached-release"} release={release} />
          ))}
        </div>
      )}
    </div>
  );
}

function ReleaseCard({ release }: { release: CachedReleaseResponse }) {
  const remove = useRemoveCachedRelease();
  const [confirming, setConfirming] = useState(false);

  async function purge() {
    try {
      await remove.mutateAsync(release.releaseId ?? "");
      toast.success("Cached NZB purged.");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <article className="group relative overflow-hidden rounded-xl border bg-card p-4 transition-colors hover:border-orange-500/40">
      <div className="absolute inset-y-0 left-0 w-0.5 bg-orange-500 opacity-0 transition-opacity group-hover:opacity-100" />
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-orange-500/10 text-orange-600 dark:text-orange-400">
          <FileArchive className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="min-w-0 truncate font-medium" title={release.title ?? undefined}>{release.title ?? "Untitled release"}</h3>
            <Badge variant="outline" className="font-mono text-[10px] uppercase">{release.indexer ?? "unknown"}</Badge>
          </div>
          <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground" title={release.releaseId ?? undefined}>
            {release.releaseId}
          </p>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <Datum label="Media" value={formatBytes(release.releaseSizeBytes)} />
        <Datum label="NZB" value={formatBytes(release.nzbSizeBytes)} />
        <Datum label="Structure" value={`${release.fileCount ?? 0} files`} detail={`${(release.segmentCount ?? 0).toLocaleString()} chunks`} />
        <Datum label="Last used" value={timeAgo(release.lastAccessedAt)} detail={`${release.hitCount} cache hits`} />
      </div>

      <div className="mt-4 flex items-center justify-between border-t pt-3">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Database className="size-3.5" /> cached {timeAgo(release.cachedAt)}
        </span>
        {confirming ? (
          <div className="flex gap-1">
            <Button size="sm" variant="destructive" onClick={purge} disabled={remove.isPending}>
              {remove.isPending && <Loader2 className="animate-spin" />} Purge
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
          </div>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setConfirming(true)} className="text-muted-foreground hover:text-destructive">
            <Trash2 /> Purge NZB
          </Button>
        )}
      </div>
    </article>
  );
}

function Datum({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <div><p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p><p className="mt-0.5 text-sm font-semibold tabular-nums">{value}</p>{detail && <p className="text-[11px] text-muted-foreground">{detail}</p>}</div>;
}

function sum<T extends "nzbSizeBytes" | "releaseSizeBytes" | "hitCount">(items: CachedReleaseResponse[], key: T) {
  return items.reduce((total, item) => total + (item[key] ?? 0), 0);
}

function LoadingRows() {
  return <div className="grid gap-3 xl:grid-cols-2">{[0, 1, 2, 3].map((key) => <div key={key} className="h-44 animate-pulse rounded-xl bg-muted" />)}</div>;
}

function ErrorState({ message }: { message: string }) {
  return <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive">{message}</div>;
}
