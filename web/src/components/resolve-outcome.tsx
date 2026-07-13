import { AudioLines, Captions, Film } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { MediaStreamInfo, ResolveResponse } from "@/api/types";
import { formatBytes, formatTicks } from "@/lib/utils";

/** Colour-coded badge for a release health / resolve status (BRIEF §6.1 health checker). */
export function HealthBadge({ status }: { status?: string | null }) {
  const s = (status ?? "unknown").toLowerCase();
  const variant =
    s === "ready" ? "success" : s === "degraded" ? "default" : s === "dead" ? "destructive" : "muted";
  return (
    <Badge variant={variant} className="capitalize">
      {s}
    </Badge>
  );
}

const STATUS_COPY: Record<string, string> = {
  ready: "All sampled article segments are present on Usenet — this should play cleanly.",
  degraded: "Some article segments are missing; playback may stutter at the affected offsets.",
  dead: "Too many segments are missing to play. A healthier release of the same work is suggested below.",
};

/**
 * Renders a POST /resolve result: status in plain language, container/size/runtime, and the
 * server pre-probed media streams (BRIEF §6.2). Shared by the debug playground and the
 * playback-preview canary so both read the resolve outcome the same way.
 */
export function ResolveOutcome({ resolve }: { resolve: ResolveResponse }) {
  const status = (resolve.status ?? "unknown").toLowerCase();
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <HealthBadge status={status} />
        {resolve.container && <Badge variant="outline">{resolve.container}</Badge>}
        {resolve.sizeBytes != null && (
          <span className="text-muted-foreground">{formatBytes(resolve.sizeBytes)}</span>
        )}
        {resolve.runTimeTicks != null && (
          <span className="text-muted-foreground">· {formatTicks(resolve.runTimeTicks)}</span>
        )}
      </div>

      <p className="text-xs text-muted-foreground">{STATUS_COPY[status] ?? "Resolve complete."}</p>

      {(resolve.mediaStreams?.length ?? 0) > 0 && (
        <ul className="space-y-1" aria-label="Media streams">
          {resolve.mediaStreams!.map((s, i) => (
            <MediaStreamRow key={i} stream={s} />
          ))}
        </ul>
      )}

      {resolve.suggestedFallbackReleaseId && (
        <p className="text-xs text-muted-foreground">
          Suggested fallback release:{" "}
          <code className="rounded bg-muted px-1 py-0.5">{resolve.suggestedFallbackReleaseId}</code>
        </p>
      )}
    </div>
  );
}

function MediaStreamRow({ stream }: { stream: MediaStreamInfo }) {
  const type = stream.type ?? "";
  const Icon = type === "Video" ? Film : type === "Audio" ? AudioLines : Captions;
  const detail = [
    stream.codec,
    stream.width && stream.height ? `${stream.width}×${stream.height}` : null,
    stream.channels ? `${stream.channels}ch` : null,
    stream.language,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="w-16 shrink-0 font-medium">{type}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{detail || "—"}</span>
    </li>
  );
}
