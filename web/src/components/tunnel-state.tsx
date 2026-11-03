import { cn } from "@/lib/utils";
import { STATE_LABELS, tunnelState, type TunnelState } from "@/lib/tunnels";

const PILL: Record<TunnelState, { box: string; dot: string }> = {
  connected: {
    box: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  starting: {
    box: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    dot: "bg-sky-500 animate-pulse",
  },
  degraded: {
    box: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  down: {
    box: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
    dot: "bg-rose-500",
  },
  disabled: {
    box: "border-border bg-muted text-muted-foreground",
    dot: "bg-muted-foreground/50",
  },
};

/** Text colour per state, for icons and inline status lines next to the pill. */
export const STATE_TEXT: Record<TunnelState, string> = {
  connected: "text-emerald-600 dark:text-emerald-400",
  starting: "text-sky-600 dark:text-sky-400",
  degraded: "text-amber-600 dark:text-amber-400",
  down: "text-rose-600 dark:text-rose-400",
  disabled: "text-muted-foreground",
};

export function TunnelStatePill({
  state,
  className,
  size = "default",
}: {
  state?: string | null;
  className?: string;
  size?: "default" | "sm";
}) {
  const s = tunnelState(state);
  const tone = PILL[s];
  return (
    <span
      data-state={s}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border font-medium",
        size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs",
        tone.box,
        className,
      )}
    >
      <span className={cn("size-1.5 rounded-full", tone.dot)} aria-hidden />
      {STATE_LABELS[s]}
    </span>
  );
}
