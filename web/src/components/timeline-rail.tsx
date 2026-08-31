import { cn } from "@/lib/utils";

/** A media-timeline interval as fractions [0..1]. */
export interface TimelineRange {
  start: number;
  end: number;
}

const SIZES = {
  lg: "h-2.5",
  md: "h-2",
  sm: "h-1.5",
} as const;

/**
 * Segmented media-timeline bar: an empty track that fills only where something actually
 * happened. `watched` (Jellyfin time) renders on top, `buffered` (payload available
 * locally) as a muted underlay, and `playhead` as a tick. A viewer who started at 50%
 * gets an empty first half — the whole point of the rail.
 */
export function TimelineRail({
  watched = [],
  buffered = [],
  playhead,
  size = "md",
  label,
  failed = false,
  className,
}: {
  watched?: TimelineRange[];
  buffered?: TimelineRange[];
  playhead?: number;
  size?: keyof typeof SIZES;
  label: string;
  failed?: boolean;
  className?: string;
}) {
  return (
    <div
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "relative w-full overflow-hidden rounded-full bg-muted dark:bg-white/10",
        SIZES[size],
        className,
      )}
    >
      {buffered.map((range, index) => (
        <span
          key={`buffered-${index}`}
          className="absolute inset-y-0 bg-muted-foreground/30"
          style={segmentStyle(range)}
        />
      ))}
      {watched.map((range, index) => (
        <span
          key={`watched-${index}`}
          className={cn(
            "absolute inset-y-0 rounded-[1px]",
            failed ? "bg-destructive/80" : "bg-cyan-500",
          )}
          style={segmentStyle(range)}
        />
      ))}
      {playhead != null && Number.isFinite(playhead) && (
        <span
          className="absolute inset-y-0 w-0.5 bg-foreground/90"
          style={{ left: `${clamp01(playhead) * 100}%` }}
          aria-hidden="true"
        />
      )}
    </div>
  );
}

function segmentStyle(range: TimelineRange) {
  const start = clamp01(range.start);
  const end = Math.max(start, clamp01(range.end));
  return {
    left: `${start * 100}%`,
    width: `${Math.max(0.5, (end - start) * 100)}%`,
  };
}

function clamp01(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

/** Sort + merge overlapping/adjacent ranges (tolerance absorbs heartbeat jitter). */
export function mergeTimelineRanges(ranges: TimelineRange[], tolerance = 0.002): TimelineRange[] {
  const ordered = ranges
    .map((range) => ({ start: clamp01(range.start), end: clamp01(range.end) }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start);
  const merged: TimelineRange[] = [];
  for (const range of ordered) {
    const last = merged.at(-1);
    if (last && range.start <= last.end + tolerance) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/** Total covered share of the timeline (0..1) for merged ranges. */
export function rangeCoverage(ranges: TimelineRange[]): number {
  return Math.min(1, ranges.reduce((total, range) => total + Math.max(0, range.end - range.start), 0));
}
