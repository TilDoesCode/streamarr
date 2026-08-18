import { RadioTower, TerminalSquare } from "lucide-react";
import { LogViewer } from "@/components/log-viewer";

export function LogsPage() {
  return (
    <div className="space-y-5">
      <section className="relative isolate overflow-hidden rounded-2xl border bg-card px-5 py-6 shadow-[0_18px_55px_-42px_rgba(15,23,42,.65)] sm:px-7 sm:py-7">
        <div
          className="pointer-events-none absolute inset-0 -z-10 opacity-45"
          style={{
            backgroundImage:
              "linear-gradient(hsl(var(--primary)/.06) 1px, transparent 1px), linear-gradient(90deg,hsl(var(--primary)/.06) 1px,transparent 1px)",
            backgroundSize: "30px 30px",
            maskImage: "linear-gradient(to right, black, transparent 76%)",
          }}
        />
        <div className="pointer-events-none absolute -right-20 -top-28 -z-10 size-72 rounded-full bg-primary/10 blur-3xl" />

        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-2xl">
            <div className="flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-primary">
              <TerminalSquare className="size-4" aria-hidden="true" />
              Runtime observability
            </div>
            <h2 className="mt-3 text-2xl font-semibold tracking-[-0.035em] sm:text-3xl">System logs</h2>
            <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
              Relevant Core output and, when configured, Jellyfin server messages in one bounded operator feed.
            </p>
          </div>
          <div className="flex w-fit items-center gap-2 rounded-full border bg-background/70 px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground">
            <RadioTower className="size-3.5 text-primary" aria-hidden="true" />
            polling / 2.0s
          </div>
        </div>
      </section>

      <LogViewer />
    </div>
  );
}
