import { useMemo, useState } from "react";
import { AlertTriangle, Download, Gauge, Radio, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { errorMessage } from "@/api/client";
import { useRevokeViewerDownload, useViewerDownloads, useViewers } from "@/api/queries";
import type { DownloadAdminItemDto, DownloadMaintenanceDto } from "@/api/types";
import { EmptyOpsState, OpsMetric, OpsMetrics } from "@/components/ops-page";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn, timeAgo } from "@/lib/utils";
import type { Tone } from "@/lib/transcoding";
import { formatBytes, formatDateTime, formatRate } from "@/lib/viewers";
import {
  ConfirmDialog,
  ErrorPanel,
  LoadingBlock,
  ProgressBar,
  SectionHeading,
  ToneBadge,
  selectClassName,
  type ConfirmOptions,
} from "./shared";

const ROW_GRID = "xl:grid-cols-[minmax(0,1.1fr)_minmax(0,2.2fr)_minmax(0,0.8fr)_minmax(0,1.5fr)_minmax(0,0.8fr)_minmax(0,0.9fr)_6.5rem]";

/** The state badge of a stored download. */
export function downloadState(
  item: Pick<DownloadAdminItemDto, "state" | "transferring" | "errorCode"> & { fileUrlRevoked?: boolean | null },
): { label: string; tone: Tone; detail?: string } {
  if (item.transferring) return { label: "Transferring", tone: "info" };
  switch (item.state) {
    case "ready":
      return item.fileUrlRevoked
        ? { label: "Link revoked", tone: "warning", detail: "security sign-out · renews after sign-in" }
        : { label: "Ready", tone: "success" };
    case "completed":
      return { label: "On the device", tone: "muted" };
    case "failed":
      return { label: "Failed", tone: "danger", detail: item.errorCode ?? undefined };
    default:
      return { label: "Preparing", tone: "warning" };
  }
}

const MAINTENANCE_TEXT = {
  en: {
    title: "Download maintenance failing since",
    failures: (count: number) => `${count} failures in a row`,
    detail: "Retried automatically. The server log has a warning with the details.",
    components: { sweep: "open transfer check", accounting: "byte accounting", resume: "preparation resume", failureRecord: "failure record" },
  },
  de: {
    title: "Download-Wartung gestört seit",
    failures: (count: number) => `${count} Fehler in Folge`,
    detail: "Wird automatisch wiederholt. Das Server-Log enthält eine Warnung mit den Details.",
    components: { sweep: "Prüfung offener Übertragungen", accounting: "Byte-Zählung", resume: "Fortsetzen der Vorbereitungen", failureRecord: "Fehlervermerk" },
  },
} as const;

/** German when the browser asks for it, English otherwise. */
export function maintenanceText(language = typeof navigator === "undefined" ? "en" : navigator.language) {
  return language.toLowerCase().startsWith("de") ? MAINTENANCE_TEXT.de : MAINTENANCE_TEXT.en;
}

/** Shown only while a download maintenance component is degraded (3 or more failures in a row). */
export function MaintenanceWarning({ maintenance }: { maintenance?: DownloadMaintenanceDto[] | null }) {
  const degraded = (maintenance ?? []).filter((m) => m.degraded);
  if (degraded.length === 0) return null;
  const text = maintenanceText();
  const since = degraded.map((m) => m.failingSince).filter((at): at is string => !!at).sort()[0];
  return (
    <div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-950 dark:text-amber-100" role="alert">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-semibold">{text.title} {formatDateTime(since)}</p>
        <ul className="space-y-0.5 text-xs leading-5 text-amber-900/90 dark:text-amber-200/90">
          {degraded.map((m) => (
            <li key={m.component} className="break-words">
              <span className="font-medium">{text.components[m.component as keyof typeof text.components] ?? m.component}</span>
              {" · "}{text.failures(m.consecutiveFailures)}
              {m.lastError && <span className="font-mono"> · {m.lastError}</span>}
            </li>
          ))}
        </ul>
        <p className="text-xs text-amber-900/80 dark:text-amber-200/80">{text.detail}</p>
      </div>
    </div>
  );
}

/** Device downloads: live transfers (speed, the live-stream throttle) and the stored downloads per viewer. */
export function DownloadsTab() {
  const [viewerId, setViewerId] = useState("");
  const [activeOnly, setActiveOnly] = useState(false);
  const viewers = useViewers();
  const downloads = useViewerDownloads({ viewerId: viewerId || undefined });
  const revoke = useRevokeViewerDownload();
  const [confirm, setConfirm] = useState<ConfirmOptions | null>(null);
  const items = useMemo(
    () => (downloads.data?.items ?? []).filter((item) => !activeOnly || item.transferring),
    [downloads.data, activeOnly],
  );
  const data = downloads.data;

  function askRevoke(item: DownloadAdminItemDto) {
    setConfirm({
      title: `Revoke this download of @${item.username}?`,
      description: "Its file link stops working at once and a running transfer ends. A file already on the device stays there.",
      confirmLabel: "Revoke download",
      destructive: true,
      onConfirm: async () => {
        await revoke.mutateAsync(item.downloadId ?? "");
        toast.success("Download revoked.");
      },
    });
  }

  return (
    <div className="space-y-4">
      <SectionHeading
        id="viewer-downloads-heading"
        icon={<Download />}
        title="Device downloads"
        detail="Versions viewers keep on their devices for offline playback. The server stores no file; it passes the bytes through and yields to live streams."
      />

      <MaintenanceWarning maintenance={data?.maintenance} />

      <OpsMetrics>
        <OpsMetric label="Transferring" value={data ? String(data.activeTransfers) : "—"} detail="downloads with an open request" />
        <OpsMetric
          label="Stored"
          value={data ? String(data.items?.length ?? 0) : "—"}
          detail={data ? `${(data.items ?? []).filter((item) => item.state === "completed").length} on devices` : undefined}
        />
        <OpsMetric label="Speed" value={data ? formatRate(data.bytesPerSecond) : "—"} detail="all downloads together" />
        <OpsMetric
          label="Live streams"
          value={data ? String(data.liveStreams) : "—"}
          detail={data ? (data.throttled ? "downloads held to the streaming cap" : "downloads at full speed") : undefined}
        />
      </OpsMetrics>

      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-2">
          <Label htmlFor="downloads-viewer">Viewer</Label>
          <select id="downloads-viewer" className={cn(selectClassName, "min-w-48")} value={viewerId} onChange={(event) => setViewerId(event.target.value)}>
            <option value="">All viewers</option>
            {(viewers.data ?? []).map((viewer) => (
              <option key={viewer.id} value={viewer.id ?? ""}>@{viewer.username}</option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input type="checkbox" className="size-4 accent-cyan-600" checked={activeOnly} onChange={(event) => setActiveOnly(event.target.checked)} />
          Only transferring
        </label>
        {data?.throttled && (
          <ToneBadge tone="warning" className="mb-2">
            <Radio className="mr-1 size-3" />A live stream plays — downloads are held back
          </ToneBadge>
        )}
      </div>

      {downloads.isLoading ? (
        <LoadingBlock label="Loading downloads" />
      ) : downloads.isError ? (
        <ErrorPanel message={errorMessage(downloads.error)} />
      ) : items.length === 0 ? (
        <EmptyOpsState
          icon={<Download className="size-5" />}
          title={activeOnly ? "Nothing is transferring" : "No downloads yet"}
          description="When a viewer downloads a movie or episode in the app, it shows up here with its progress and speed."
        />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div
            className={cn(
              "hidden gap-4 border-b bg-muted/30 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground dark:bg-zinc-900/40 xl:grid",
              ROW_GRID,
            )}
            aria-hidden
          >
            <span>Viewer</span>
            <span>Title · release</span>
            <span>State</span>
            <span>Transferred</span>
            <span>Speed</span>
            <span>Last transfer</span>
            <span className="text-right">Actions</span>
          </div>
          <ul className="divide-y" aria-labelledby="viewer-downloads-heading">
            {items.map((item) => (
              <DownloadRow key={item.downloadId} item={item} onRevoke={() => askRevoke(item)} />
            ))}
          </ul>
        </div>
      )}

      <ConfirmDialog options={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

function DownloadRow({ item, onRevoke }: { item: DownloadAdminItemDto; onRevoke: () => void }) {
  const state = downloadState(item);
  const size = item.sizeBytes ?? 0;
  const served = item.bytesServed ?? 0;
  const share = size > 0 ? Math.min(1, served / size) : 0;
  return (
    <li className={cn("grid gap-3 px-4 py-3 text-sm xl:items-center xl:gap-4", ROW_GRID)}>
      <div className="min-w-0">
        <p className="truncate font-medium">@{item.username}</p>
        <p className="truncate text-xs text-muted-foreground">{item.deviceName ?? "Unnamed device"}</p>
      </div>
      <div className="min-w-0">
        <p className="truncate">{item.title ?? item.workId}</p>
        <p className="truncate font-mono text-[11px] text-muted-foreground" title={item.releaseName ?? undefined}>{item.releaseName ?? "—"}</p>
      </div>
      <div className="min-w-0 space-y-1">
        <ToneBadge tone={state.tone}>{state.label}</ToneBadge>
        {state.detail && <p className="truncate font-mono text-[11px] text-muted-foreground" title={state.detail}>{state.detail}</p>}
      </div>
      <div className="min-w-0 space-y-1">
        {size > 0 ? (
          <>
            <p className="text-xs tabular-nums">
              {formatBytes(served)} <span className="text-muted-foreground">of {formatBytes(size)}</span>
            </p>
            <ProgressBar value={share} label={`${Math.round(share * 100)} % transferred`} />
          </>
        ) : (
          <p className="text-xs text-muted-foreground">—</p>
        )}
      </div>
      <p className="flex items-center gap-1 text-xs tabular-nums">
        <Gauge className="size-3.5 text-muted-foreground" aria-hidden />
        {item.transferring ? formatRate(item.bytesPerSecond) : "—"}
      </p>
      <p className="text-xs text-muted-foreground">{timeAgo(item.lastTransferAt)}</p>
      <div className="flex justify-end">
        <Button type="button" size="sm" variant="outline" onClick={onRevoke} aria-label={`Revoke the download of ${item.title ?? item.workId} for @${item.username}`}>
          <Trash2 />Revoke
        </Button>
      </div>
    </li>
  );
}
