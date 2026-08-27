import type { StreamEventResponse, StreamingHistoryResponse } from "@/api/types";
import { cn, formatTicks, timeAgo } from "@/lib/utils";
import { formatMs, formatTimestamp } from "./format";

/** The "Events" sub screen (live variant): recent client playback events correlated to this stream. */
export function EventTimeline({ events }: { events: StreamingHistoryResponse[] }) {
  if (!events.length) {
    return (
      <div className="flex min-h-28 items-center justify-center rounded-xl border border-dashed px-6 text-center font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
        No correlated playback events have arrived for this stream
      </div>
    );
  }
  return (
    <ol className="grid gap-2 lg:grid-cols-3">
      {events.slice(0, 6).map((event, index) => (
        <li key={event.id ?? `${event.event}-${index}`} className="min-w-0 rounded-xl border bg-muted/20 p-4 transition-colors hover:bg-muted/35">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-primary"><span className="size-1.5 rounded-full bg-primary" />{event.event || "progress"}</span>
            <span className="font-mono text-[9px] text-muted-foreground/70">{timeAgo(event.receivedAt)}</span>
          </div>
          <p className="mt-4 font-mono text-lg tabular-nums text-foreground">{formatTicks(event.positionTicks)}</p>
          <p className="mt-1 truncate text-[10px] text-muted-foreground">{event.externalUserName || event.source} / {event.deviceName || "unknown device"}</p>
        </li>
      ))}
    </ol>
  );
}

/** The "Events" sub screen (historical variant): full chronological event log for a retained stream. */
export function EventLog({ events }: { events: StreamEventResponse[] }) {
  if (!events.length) {
    return (
      <div className="flex min-h-28 items-center justify-center rounded-xl border border-dashed px-6 text-center font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
        No diagnostic events were recorded for this stream
      </div>
    );
  }
  return (
    <ol className="space-y-1.5">
      {events.map((event, index) => (
        <li
          key={`${event.atUtc}-${index}`}
          className="flex items-start gap-3 rounded-lg border bg-muted/15 px-3 py-2.5 text-xs transition-colors hover:bg-muted/30"
        >
          <span className={cn("mt-1 size-1.5 shrink-0 rounded-full", eventSourceDot(event.source))} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                {event.source}/{event.category}
              </span>
              <span className="font-medium text-foreground">{event.name}</span>
              {event.durationMs != null && (
                <span className="font-mono text-[9px] text-muted-foreground/70">{formatMs(event.durationMs)}</span>
              )}
            </div>
            {event.detail && (
              <p className="mt-0.5 truncate text-muted-foreground" title={event.detail}>
                {event.detail}
              </p>
            )}
          </div>
          <span className="shrink-0 font-mono text-[9px] text-muted-foreground/70">{formatTimestamp(event.atUtc)}</span>
        </li>
      ))}
    </ol>
  );
}

function eventSourceDot(source?: string | null) {
  switch (source) {
    case "ttff":
      return "bg-primary";
    case "repair":
      return "bg-amber-500";
    case "error":
      return "bg-rose-500";
    default:
      return "bg-slate-400"; // lifecycle
  }
}
