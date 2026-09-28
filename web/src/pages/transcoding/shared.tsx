import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { toneBadgeClass, type Tone } from "@/lib/transcoding";
import { cn } from "@/lib/utils";

export function ToneBadge({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return <Badge className={cn("whitespace-nowrap", toneBadgeClass[tone], className)}>{children}</Badge>;
}

export function SectionHeading({
  id,
  icon,
  title,
  detail,
  action,
}: {
  id?: string;
  icon: ReactNode;
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-1">
      <span className="mt-0.5 text-lime-600 dark:text-lime-400 [&_svg]:size-4">{icon}</span>
      <div className="min-w-0 flex-1">
        <h3 id={id} className="text-sm font-semibold">{title}</h3>
        {detail && <p className="text-xs leading-5 text-muted-foreground">{detail}</p>}
      </div>
      {action}
    </div>
  );
}

export function ErrorPanel({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive" role="alert">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      {message}
    </div>
  );
}

export function LoadingBlock({ label, className }: { label: string; className?: string }) {
  return <div className={cn("h-40 animate-pulse rounded-xl border bg-muted/30", className)} aria-label={label} role="status" />;
}

export function ProgressBar({
  value,
  label,
  className,
  barClassName,
}: {
  value: number;
  label: string;
  className?: string;
  barClassName?: string;
}) {
  const percent = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div
      className={cn("h-1.5 overflow-hidden rounded-full bg-muted dark:bg-white/10", className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <div
        className={cn("h-full origin-left rounded-full bg-lime-500 transition-transform duration-500", barClassName)}
        style={{ transform: `scaleX(${percent / 100})` }}
      />
    </div>
  );
}

export const selectClassName =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";
