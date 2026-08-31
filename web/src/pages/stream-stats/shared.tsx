import { useEffect, useRef, useState } from "react";
import { ShieldCheck, Clock3, AlertTriangle } from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { SessionResponse } from "@/api/types";
import type { TimelineRange } from "@/components/timeline-rail";
import { cn } from "@/lib/utils";
import { formatRate, formatRateCompact } from "./format";

/** Small heading used at the top of every sub screen's content panel. */
export function SectionHeading({ icon, eyebrow, title, detail }: { icon: React.ReactNode; eyebrow: string; title: string; detail: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/35 text-primary [&_svg]:size-4">{icon}</span>
      <div>
        <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground/75">{eyebrow}</p>
        <h3 className="mt-1 font-semibold tracking-tight text-foreground">{title}</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

export function MetricCell({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail: string }) {
  return (
    <div className="min-w-0 p-4 even:border-l md:border-l md:first:border-l-0 sm:p-5 lg:px-8">
      <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground [&_svg]:size-3.5 [&_svg]:text-primary">{icon}{label}</div>
      <p className="mt-2 truncate font-mono text-xl font-medium tabular-nums text-foreground">{value}</p>
      <p className="mt-1 truncate text-[11px] text-muted-foreground/80">{detail}</p>
    </div>
  );
}

export function ConsoleBackdrop() {
  return (
    <>
      <div
        className="pointer-events-none absolute inset-0 -z-10 opacity-50"
        style={{
          backgroundImage: "linear-gradient(hsl(var(--primary) / .055) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--primary) / .055) 1px, transparent 1px)",
          backgroundSize: "28px 28px",
          maskImage: "linear-gradient(to bottom, black, transparent 42%)",
        }}
      />
      <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-80 bg-[radial-gradient(ellipse_at_top_right,hsl(var(--primary)/.11),transparent_64%)]" />
    </>
  );
}

export function LiveIndicator({ fetching }: { fetching: boolean }) {
  return (
    <span className="flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-success-foreground">
      <span className="relative flex size-2">
        <span className={cn("absolute inline-flex size-full rounded-full bg-success opacity-40", fetching && "animate-ping")} />
        <span className="relative inline-flex size-2 rounded-full bg-success" />
      </span>
      {fetching ? "sampling" : "live signal"}
    </span>
  );
}

export function StatusBadge({ state }: { state?: string | null }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-success/20 bg-success/10 px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-success-foreground">
      <ShieldCheck className="size-3" /> {state || "ready"}
    </span>
  );
}

export function FinalStateBadge({ state }: { state?: string | null }) {
  const label = state ?? "open";
  const isGood = state === "closed" || state === "purged" || state === "reused";
  const isBad = state === "dead" || state === "error" || state === "evicted" || state === "expired" || state === "invalidated";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider",
        isGood && "border-success/20 bg-success/10 text-success-foreground",
        isBad && "border-destructive/20 bg-destructive/10 text-destructive",
        !isGood && !isBad && "border-muted-foreground/20 bg-muted/40 text-muted-foreground",
      )}
    >
      {isGood ? <ShieldCheck className="size-3" /> : isBad ? <AlertTriangle className="size-3" /> : <Clock3 className="size-3" />}
      {label}
    </span>
  );
}

/**
 * 48-cell payload rail lit from real byte intervals: a cell fills when the client actually
 * pulled those bytes (delivered) and outlines when they are buffered locally from Usenet —
 * a viewer who seeks to the middle lights the middle, not a fake prefix.
 */
export function SegmentRail({
  delivered,
  buffered,
  label,
}: {
  delivered: TimelineRange[];
  buffered: TimelineRange[];
  label: string;
}) {
  const cells = 48;
  return (
    <div className="grid h-7 grid-cols-[repeat(48,minmax(0,1fr))] gap-1 rounded-lg border bg-muted/30 p-1.5" role="img" aria-label={label}>
      {Array.from({ length: cells }, (_, index) => {
        const start = index / cells;
        const end = (index + 1) / cells;
        return (
          <span
            key={index}
            className={cn(
              "rounded-[2px] bg-muted-foreground/15 transition-colors duration-700",
              coverageWithin(buffered, start, end) >= 0.35 && "border border-primary/35",
              coverageWithin(delivered, start, end) >= 0.35 && "border-transparent bg-primary",
            )}
          />
        );
      })}
    </div>
  );
}

function coverageWithin(ranges: TimelineRange[], start: number, end: number) {
  const width = end - start;
  if (width <= 0) return 0;
  let covered = 0;
  for (const range of ranges) {
    covered += Math.max(0, Math.min(end, range.end) - Math.max(start, range.start));
  }
  return covered / width;
}

interface RateSample {
  index: number;
  rate: number;
}

export function useTransferRate(session?: SessionResponse) {
  const [samples, setSamples] = useState<RateSample[]>([]);
  const previous = useRef<{ at: number; bytes: number } | null>(null);
  const bytes = session?.bytesServed ?? 0;
  const token = session?.token;

  useEffect(() => {
    const at = performance.now();
    if (!previous.current || !token) {
      previous.current = token ? { at, bytes } : null;
      return;
    }
    const elapsed = (at - previous.current.at) / 1_000;
    const delta = Math.max(0, bytes - previous.current.bytes);
    if (elapsed > 0.25) {
      setSamples((current) => [...current.slice(-29), { index: (current.at(-1)?.index ?? 0) + 1, rate: delta / elapsed }]);
      previous.current = { at, bytes };
    }
  }, [bytes, token]);

  return samples;
}

export function RateChart({ samples }: { samples: RateSample[] }) {
  const data = samples.length > 1
    ? samples
    : samples.length === 1
      ? [{ index: 0, rate: samples[0].rate }, samples[0]]
      : [{ index: 0, rate: 0 }, { index: 1, rate: 0 }];
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 8, right: 2, bottom: 0, left: -22 }}>
        <defs>
          <linearGradient id="stream-rate-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.24} />
            <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 5" vertical={false} />
        <XAxis dataKey="index" hide />
        <YAxis tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))", fontFamily: "monospace" }} tickLine={false} axisLine={false} tickFormatter={(rate) => formatRateCompact(Number(rate))} />
        <Tooltip
          cursor={{ stroke: "hsl(var(--muted-foreground))", strokeDasharray: "3 3" }}
          contentStyle={{ background: "hsl(var(--card))", color: "hsl(var(--card-foreground))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontFamily: "monospace", fontSize: 11 }}
          labelStyle={{ display: "none" }}
          formatter={(rate: number) => [formatRate(rate), "rate"]}
        />
        <Area type="monotone" dataKey="rate" stroke="hsl(var(--primary))" strokeWidth={1.5} fill="url(#stream-rate-fill)" isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function MiniMetric({ label, value, className }: { label: string; value: string; className?: string }) {
  return <div className={className}><p className="text-[9px] uppercase tracking-wider text-muted-foreground/75">{label}</p><p className="mt-1 truncate text-xs text-foreground">{value}</p></div>;
}
