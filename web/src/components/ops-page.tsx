import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function OpsHero({
  eyebrow,
  title,
  description,
  accent = "orange",
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  accent?: "orange" | "cyan" | "lime";
  children?: ReactNode;
}) {
  const accentClass = {
    orange: "bg-orange-500 text-orange-950",
    cyan: "bg-cyan-400 text-cyan-950",
    lime: "bg-lime-400 text-lime-950",
  }[accent];
  const glowClass = {
    orange: "bg-orange-500/10 dark:bg-orange-500/15",
    cyan: "bg-cyan-400/10 dark:bg-cyan-400/15",
    lime: "bg-lime-400/10 dark:bg-lime-400/15",
  }[accent];

  return (
    <section className="relative isolate overflow-hidden rounded-2xl border bg-card px-5 py-6 text-card-foreground shadow-[0_18px_50px_-38px_rgba(15,23,42,.45)] dark:bg-zinc-950 dark:text-zinc-100 dark:shadow-[0_22px_70px_-42px_rgba(0,0,0,.85)] sm:px-7 sm:py-8">
      <div
        className="pointer-events-none absolute inset-0 -z-10 opacity-50 dark:hidden"
        style={{
          backgroundImage:
            "linear-gradient(rgba(24,24,27,.05) 1px, transparent 1px), linear-gradient(90deg, rgba(24,24,27,.05) 1px, transparent 1px)",
          backgroundSize: "32px 32px",
          maskImage: "linear-gradient(to right, transparent, black 35%, black)",
        }}
      />
      <div
        className="pointer-events-none absolute inset-0 -z-10 hidden opacity-30 dark:block"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,.06) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.06) 1px, transparent 1px)",
          backgroundSize: "32px 32px",
          maskImage: "linear-gradient(to right, transparent, black 35%, black)",
        }}
      />
      <div className={cn("pointer-events-none absolute -right-20 -top-28 -z-10 size-72 rounded-full blur-3xl", glowClass)} />

      <div className="relative flex flex-col gap-7 xl:flex-row xl:items-end xl:justify-between">
        <div className="max-w-2xl">
          <div className="mb-5 flex items-center gap-3">
            <span className={cn("h-2 w-10 rounded-full", accentClass)} />
            <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground dark:text-zinc-400">
              {eyebrow}
            </span>
          </div>
          <h2 className="max-w-xl text-3xl font-semibold leading-[1.04] tracking-[-0.035em] sm:text-4xl">
            {title}
          </h2>
          <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground dark:text-zinc-400">
            {description}
          </p>
        </div>
        {children && <div className="w-full xl:max-w-2xl">{children}</div>}
      </div>
    </section>
  );
}

export function OpsMetrics({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-border dark:bg-white/10 lg:grid-cols-4">
      {children}
    </div>
  );
}

export function OpsMetric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="min-w-0 bg-muted/45 px-4 py-3 backdrop-blur-sm dark:bg-zinc-900/80">
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground dark:text-zinc-500">
        {label}
      </p>
      <p className="mt-1 truncate text-xl font-semibold tabular-nums text-foreground dark:text-white">
        {value}
      </p>
      {detail && (
        <p className="truncate text-[11px] text-muted-foreground dark:text-zinc-500">{detail}</p>
      )}
    </div>
  );
}

export function EmptyOpsState({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center rounded-2xl border border-dashed bg-card/40 px-6 text-center">
      <div className="mb-4 flex size-12 items-center justify-center rounded-full border bg-background text-muted-foreground">
        {icon}
      </div>
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-1 max-w-md text-sm leading-6 text-muted-foreground">{description}</p>
    </div>
  );
}
