import { ChevronRight, Eraser, SquareTerminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ViewerLogEntry } from "@/lib/viewer-client";
import { cn } from "@/lib/utils";
import { Panel } from "../shared";
import { useHarness } from "./use-harness";

function statusClass(status: number | null): string {
  if (status === null || status >= 500) return "bg-red-500/15 text-red-700 dark:text-red-300";
  if (status >= 400) return "bg-amber-500/15 text-amber-800 dark:text-amber-300";
  if (status >= 300 || status === 202 || status === 204) return "bg-sky-500/15 text-sky-700 dark:text-sky-300";
  return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
}

export function ApiLogPanel() {
  const { log, clearLog } = useHarness();
  return (
    <Panel
      icon={<SquareTerminal />}
      title="API log"
      description="Every viewer API call of this harness, newest first. Tokens, passwords and codes are redacted."
      action={
        <Button type="button" size="sm" variant="ghost" onClick={clearLog} disabled={log.length === 0}>
          <Eraser />Clear
        </Button>
      }
    >
      {log.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-xs text-muted-foreground">No calls yet.</p>
      ) : (
        <ol className="-mx-1 max-h-[26rem] space-y-1 overflow-y-auto px-1" aria-label="API calls">
          {log.map((entry) => <LogRow key={entry.id} entry={entry} />)}
        </ol>
      )}
    </Panel>
  );
}

function LogRow({ entry }: { entry: ViewerLogEntry }) {
  const path = entry.path.replace(/^\/api\/v1/, "");
  return (
    <li>
      <details className="group rounded-md border bg-background/60 dark:bg-zinc-900/40">
        <summary
          className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1.5 font-mono text-[11px] hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
          aria-label={`${entry.method} ${path} ${entry.status ?? "failed"} in ${entry.durationMs} ms`}
        >
          <ChevronRight className="size-3 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden />
          <span className="w-12 shrink-0 font-semibold">{entry.method}</span>
          <span className="min-w-0 flex-1 truncate" title={entry.path}>{path}</span>
          {entry.retry && <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">retry</span>}
          <span className={cn("shrink-0 rounded px-1.5 py-0.5 font-semibold tabular-nums", statusClass(entry.status))}>
            {entry.status ?? "ERR"}
          </span>
          <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">{entry.durationMs} ms</span>
        </summary>
        <div className="space-y-2 border-t px-2 py-2 text-[11px]">
          <p className="font-mono text-muted-foreground">
            {new Date(entry.at).toLocaleTimeString()} · {entry.auth ?? "anonymous"} · credentials: omit
            {entry.errorCode ? ` · ${entry.errorCode}` : ""}
          </p>
          {entry.requestBody !== undefined && <JsonBlock title="Request" value={entry.requestBody} />}
          {entry.responseBody !== undefined ? <JsonBlock title="Response" value={entry.responseBody} /> : <p className="text-muted-foreground">Empty response body.</p>}
        </div>
      </details>
    </li>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <div>
      <p className="mb-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{title}</p>
      <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/50 p-2 font-mono text-[11px] leading-4 text-foreground/90 dark:bg-black/30">
        {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
