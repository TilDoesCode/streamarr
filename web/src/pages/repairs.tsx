import { Fragment, useId, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, Wrench, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useCancelRepair, useRepairs } from "@/api/queries";
import type { RepairArtifactResponse, RepairJobResponse } from "@/api/types";
import { errorMessage } from "@/api/client";
import { cn, formatBytes, formatSeconds, timeAgo } from "@/lib/utils";

const ACTIVE_STATES = new Set([
  "queued",
  "planning",
  "materializingsources",
  "downloadingrecovery",
  "reconstructing",
  "verifying",
]);

/** True while a job is still running (and can therefore be cancelled). */
export function isActiveRepairState(state?: string | null): boolean {
  return ACTIVE_STATES.has((state ?? "").toLowerCase());
}

/** "materializingSources" → "materializing sources" for badges and event rows. */
function humanizeState(value?: string | null): string {
  return (value ?? "unknown").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

export function RepairsPage() {
  const { data, isLoading, isError, error, isFetching } = useRepairs();
  const initialError = isError && data == null;
  const refreshError = isError && data != null;

  const jobs = useMemo(
    () =>
      [...(data?.jobs ?? [])].sort(
        (a, b) => new Date(b.createdAtUtc ?? 0).getTime() - new Date(a.createdAtUtc ?? 0).getTime(),
      ),
    [data?.jobs],
  );
  const artifacts = data?.artifacts ?? [];
  const activeCount = jobs.filter((j) => isActiveRepairState(j.state)).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-semibold tracking-tight">Repairs</h2>
          {isFetching && data && (
            <Loader2
              className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
              aria-hidden="true"
            />
          )}
          {data && (
            <Badge variant={data.enabled ? "success" : "muted"}>
              {data.enabled ? "Enabled" : "Disabled"}
            </Badge>
          )}
          {data?.policy && (
            <Badge variant="outline" className="capitalize">
              {humanizeState(data.policy)}
            </Badge>
          )}
        </div>
        {data && (
          <span className="text-sm text-muted-foreground sm:ml-auto">
            {activeCount} active · {formatBytes(data.cacheBytesUsed)} /{" "}
            {formatBytes(data.cacheBudgetBytes)} artifact cache
          </span>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        PAR2 repair jobs polled every few seconds: disposition, live phase progress,
        damaged/recovery block counts and the per-job event log. Cancel tears an active job down;
        published artifacts stay cached until evicted.
      </p>

      {refreshError && (
        <div
          className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"
          role="status"
          aria-live="polite"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>
            Refresh failed. Showing the last repair data received. {errorMessage(error)}
          </span>
        </div>
      )}

      {isLoading ? (
        <div role="status" aria-live="polite">
          <span className="sr-only">Loading repair jobs.</span>
          <div
            className="h-40 w-full animate-pulse rounded-lg bg-muted motion-reduce:animate-none"
            aria-hidden="true"
          />
        </div>
      ) : initialError ? (
        <Card role="alert">
          <CardContent className="flex items-center gap-2 pt-6 text-sm text-destructive">
            <AlertTriangle className="size-4" aria-hidden="true" />
            {errorMessage(error)}
          </CardContent>
        </Card>
      ) : jobs.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
              <Wrench className="size-6" aria-hidden="true" />
            </span>
            <p className="max-w-md text-sm text-muted-foreground">
              {data?.enabled === false
                ? "PAR2 repair is disabled in the Core configuration. " +
                  "Enable Streamarr:Repair:Enabled to start repair jobs."
                : "No repair jobs yet. Jobs appear here when a damaged release is resolved " +
                  "or a repair is started manually."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="space-y-3 xl:hidden" role="list" aria-label="Repair jobs">
            {jobs.map((job) => (
              <RepairJobCard key={job.jobId} job={job} />
            ))}
          </div>
          <div
            className="hidden overflow-x-auto rounded-lg border xl:block"
            role="region"
            aria-label="Repair jobs"
            tabIndex={0}
          >
            <table className="w-full table-fixed text-sm">
              <caption className="sr-only">PAR2 repair jobs and current progress</caption>
              <colgroup>
                <col className="w-28" />
                <col />
                <col className="w-32" />
                <col className="w-28" />
                <col className="w-48" />
                <col className="w-28" />
                <col className="w-32" />
              </colgroup>
              <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th scope="col" className="sticky left-0 bg-muted px-3 py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    Release
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    State
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    Disposition
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    Progress
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Blocks
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Timing
                  </th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <RepairJobRow key={job.jobId} job={job} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {!initialError && <ArtifactsSection artifacts={artifacts} loading={isLoading} />}
    </div>
  );
}

/** Colour-coded repair state: ready green, failed red, cancelled muted, in-flight blue/amber. */
function RepairStateBadge({ state }: { state?: string | null }) {
  const s = (state ?? "unknown").toLowerCase();
  if (s === "ready") return <Badge variant="success">ready</Badge>;
  if (s === "failed") return <Badge variant="destructive">failed</Badge>;
  if (s === "cancelled" || s === "evicted" || s === "none" || s === "unknown") {
    return <Badge variant="muted">{s}</Badge>;
  }
  if (ACTIVE_STATES.has(s)) {
    // In-flight: queued waits amber, everything actively working runs blue.
    const className =
      s === "queued"
        ? "border-transparent bg-amber-500/15 text-amber-800 dark:text-amber-300"
        : "border-transparent bg-blue-500/15 text-blue-700 dark:text-blue-300";
    return <Badge className={className}>{humanizeState(state)}</Badge>;
  }
  return <Badge variant="muted">{humanizeState(state)}</Badge>;
}

function RepairJobRow({ job }: { job: RepairJobResponse }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const title = job.releaseTitle || job.releaseId || job.fingerprint || "unknown release";
  const active = isActiveRepairState(job.state);
  const failed = (job.state ?? "").toLowerCase() === "failed";
  // Newest last so the log reads top-down like a tail -f.
  const events = sortedEvents(job);

  return (
    <Fragment>
      <tr className="group border-t transition-colors hover:bg-muted/35">
        <td className="sticky left-0 bg-card px-3 py-2 text-right shadow-[8px_0_12px_-12px_hsl(var(--foreground))]">
          {active ? (
            <CancelControl job={job} title={title} />
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </td>
        <td className="px-3 py-2">
          <div className="flex flex-col gap-0.5">
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              aria-controls={detailsId}
              aria-label={`Toggle event log for ${title}`}
              className="flex w-full min-w-0 items-center gap-1.5 text-left font-mono text-xs font-medium underline-offset-4 transition-colors hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title={title}
            >
              {expanded ? (
                <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
              ) : (
                <ChevronRight
                  className="size-3 shrink-0 opacity-40 transition-opacity group-hover:opacity-100"
                  aria-hidden="true"
                />
              )}
              <span className="min-w-0 truncate">{title}</span>
            </button>
            {failed && job.failureReason && (
              <span
                className="max-w-[22rem] truncate pl-[1.125rem] text-xs text-destructive"
                title={job.failureReason}
              >
                {job.failureReason}
              </span>
            )}
          </div>
        </td>
        <td className="px-3 py-2">
          <div className="flex flex-col gap-0.5">
            <RepairStateBadge state={job.state} />
            {active && job.phase && (
              <span className="text-xs text-muted-foreground">{humanizeState(job.phase)}</span>
            )}
          </div>
        </td>
        <td className="px-3 py-2">
          <Badge variant="outline">{humanizeState(job.disposition)}</Badge>
        </td>
        <td className="px-3 py-2">
          <RepairProgress job={job} active={active} failed={failed} className="min-w-0 w-full" />
          <div className="mt-1 flex items-center justify-between gap-2 text-[11px] tabular-nums text-muted-foreground">
            <span>{job.etaSeconds != null ? `ETA ${formatSeconds(job.etaSeconds)}` : "No ETA"}</span>
            <span>{job.waiters ?? 0} waiting</span>
          </div>
        </td>
        <td
          className="px-3 py-2 text-right text-xs tabular-nums"
          title={`${job.damagedBlocks ?? 0} damaged blocks · ${job.recoveryBlocksUsed ?? 0} recovery blocks used`}
        >
          {job.damagedBlocks ?? 0} dmg · {job.recoveryBlocksUsed ?? 0} rec
        </td>
        <td className="px-3 py-2 text-right text-xs tabular-nums text-muted-foreground">
          <div className="flex flex-col items-end gap-0.5">
            <span title={job.createdAtUtc ?? undefined}>created {timeAgo(job.createdAtUtc)}</span>
            {job.completedAtUtc && (
              <span title={job.completedAtUtc}>done {timeAgo(job.completedAtUtc)}</span>
            )}
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="border-t bg-muted/20">
          <td colSpan={7} className="px-3 py-3">
            <RepairJobDetails
              id={detailsId}
              job={job}
              title={title}
              events={events}
            />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function RepairJobCard({ job }: { job: RepairJobResponse }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const title = job.releaseTitle || job.releaseId || job.fingerprint || "unknown release";
  const active = isActiveRepairState(job.state);
  const failed = (job.state ?? "").toLowerCase() === "failed";
  const events = sortedEvents(job);

  return (
    <Card role="listitem">
      <CardContent className="space-y-3 p-4">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            aria-controls={detailsId}
            aria-label={`Toggle event log for ${title}`}
            className="flex min-h-8 w-full min-w-0 items-start gap-2 overflow-hidden rounded-sm text-left font-mono text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {expanded ? (
              <ChevronDown className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            ) : (
              <ChevronRight className="mt-0.5 size-4 shrink-0 opacity-50" aria-hidden="true" />
            )}
            <span className="min-w-0 [overflow-wrap:anywhere]">{title}</span>
          </button>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <RepairStateBadge state={job.state} />
            {active && job.phase && (
              <span className="text-[11px] text-muted-foreground">
                {humanizeState(job.phase)}
              </span>
            )}
          </div>
        </div>

        {failed && job.failureReason && (
          <p className="break-words text-xs text-destructive">{job.failureReason}</p>
        )}

        <RepairProgress job={job} active={active} failed={failed} />

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t pt-3 text-xs">
          <Metric label="Disposition">
            <Badge variant="outline">{humanizeState(job.disposition)}</Badge>
          </Metric>
          <Metric label="Blocks">
            {job.damagedBlocks ?? 0} damaged · {job.recoveryBlocksUsed ?? 0} recovery
          </Metric>
          <Metric label="ETA">
            {job.etaSeconds != null ? formatSeconds(job.etaSeconds) : "—"}
          </Metric>
          <Metric label="Waiters">{job.waiters ?? 0}</Metric>
          <Metric label="Created">{timeAgo(job.createdAtUtc)}</Metric>
          <Metric label="Completed">
            {job.completedAtUtc ? timeAgo(job.completedAtUtc) : "—"}
          </Metric>
        </dl>

        {active && (
          <div className="flex justify-end border-t pt-3">
            <CancelControl job={job} title={title} />
          </div>
        )}

        {expanded && (
          <div className="border-t pt-3">
            <RepairJobDetails
              id={detailsId}
              job={job}
              title={title}
              events={events}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Metric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words font-medium tabular-nums">{children}</dd>
    </div>
  );
}

function RepairProgress({
  job,
  active,
  failed,
  className,
}: {
  job: RepairJobResponse;
  active: boolean;
  failed: boolean;
  className?: string;
}) {
  const pct = progressPercent(job);
  const indeterminate = active && !(job.totalBytes != null && job.totalBytes > 0);
  return (
    <div className={className}>
      <div className="flex items-center justify-between gap-2 text-xs tabular-nums">
        <span>{indeterminate ? "Preparing…" : `${pct}%`}</span>
        <span className="text-muted-foreground">
          {indeterminate
            ? "Total size pending"
            : `${formatBytes(job.processedBytes)} / ${formatBytes(job.totalBytes)}`}
        </span>
      </div>
      <div
        className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label="Repair progress"
        aria-valuemin={indeterminate ? undefined : 0}
        aria-valuemax={indeterminate ? undefined : 100}
        aria-valuenow={indeterminate ? undefined : pct}
        aria-valuetext={indeterminate ? "Total size pending" : undefined}
      >
        <div
          className={cn(
            "h-full rounded-full",
            indeterminate
              ? "w-1/3 animate-pulse motion-reduce:animate-none"
              : "transition-transform motion-reduce:transition-none",
            failed ? "bg-destructive" : active ? "bg-blue-500" : "bg-primary",
          )}
          style={
            indeterminate
              ? undefined
              : { transform: `scaleX(${pct / 100})`, transformOrigin: "left" }
          }
        />
      </div>
    </div>
  );
}

function RepairJobDetails({
  id,
  job,
  title,
  events,
}: {
  id: string;
  job: RepairJobResponse;
  title: string;
  events: NonNullable<RepairJobResponse["events"]>;
}) {
  return (
    <div id={id} className="space-y-2">
      <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground">
        <span>job / {job.jobId ?? "—"}</span>
        <span>fingerprint / {job.fingerprint ?? "—"}</span>
        <span>source dl {formatBytes(job.sourceBytesDownloaded)}</span>
        <span>parity dl {formatBytes(job.parityBytesDownloaded)}</span>
      </div>
      {events.length === 0 ? (
        <p className="text-xs text-muted-foreground">No events recorded yet.</p>
      ) : (
        <div
          className="max-h-56 overflow-y-auto rounded-md border bg-card p-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          role="log"
          aria-label={`Event log for ${title}`}
          aria-relevant="additions text"
          tabIndex={0}
        >
          <ol className="space-y-1.5">
            {withEventKeys(events).map(({ event, key }) => (
              <li
                key={key}
                className="grid grid-cols-[auto_1fr] items-baseline gap-x-2 gap-y-0.5 sm:grid-cols-[auto_10rem_1fr]"
              >
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {eventTime(event.atUtc)}
                </span>
                <span className="min-w-0 truncate font-medium">
                  {humanizeState(event.state)}
                </span>
                <span className="col-span-2 min-w-0 whitespace-pre-wrap break-words text-muted-foreground sm:col-span-1">
                  {event.message ?? ""}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function CancelControl({ job, title }: { job: RepairJobResponse; title: string }) {
  const cancel = useCancelRepair();
  const [open, setOpen] = useState(false);

  async function onCancel() {
    if (!job.jobId) return;
    try {
      await cancel.mutateAsync(job.jobId);
      toast.success("Repair job cancelled.");
      setOpen(false);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!cancel.isPending) setOpen(nextOpen);
      }}
    >
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          disabled={!job.jobId}
          aria-label={`Cancel repair job ${title}`}
        >
          <XCircle className="size-4" aria-hidden="true" />
          Cancel
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel repair job?</DialogTitle>
          <DialogDescription>
            This stops active repair work for “{title}” and releases its resources. Existing
            cached artifacts are not removed.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={cancel.isPending}
            aria-label={`Keep repair job ${title}`}
          >
            Keep repair
          </Button>
          <Button
            variant="destructive"
            onClick={onCancel}
            disabled={cancel.isPending}
            aria-busy={cancel.isPending}
            aria-label={`Confirm cancellation of ${title}`}
          >
            {cancel.isPending && (
              <Loader2
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            )}
            Cancel repair
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ArtifactsSection({
  artifacts,
  loading,
}: {
  artifacts: RepairArtifactResponse[];
  loading: boolean;
}) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold tracking-tight">Cached artifacts</h3>
      {loading ? (
        <div role="status" aria-live="polite">
          <span className="sr-only">Loading cached repair artifacts.</span>
          <div
            className="h-16 w-full animate-pulse rounded-lg bg-muted motion-reduce:animate-none"
            aria-hidden="true"
          />
        </div>
      ) : artifacts.length === 0 ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            No repair artifacts cached yet. A completed repair publishes its reconstructed file
            here until the cache budget evicts it.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="space-y-2 xl:hidden" role="list" aria-label="Repair artifacts">
            {artifacts.map((artifact) => (
              <RepairArtifactCard key={artifact.fingerprint} artifact={artifact} />
            ))}
          </div>
          <div
            className="hidden overflow-x-auto rounded-lg border xl:block"
            role="region"
            aria-label="Repair artifacts"
            tabIndex={0}
          >
            <table className="min-w-[40rem] w-full text-sm">
              <caption className="sr-only">Cached repaired artifacts</caption>
              <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    Release
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Size
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Created
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Last access
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Pins
                  </th>
                </tr>
              </thead>
              <tbody>
                {artifacts.map((artifact) => (
                  <tr
                    key={artifact.fingerprint}
                    className="border-t transition-colors hover:bg-muted/35"
                  >
                    <td className="px-3 py-2">
                      <span
                        className="block max-w-[26rem] truncate font-mono text-xs font-medium"
                        title={artifact.releaseTitle ?? artifact.fingerprint ?? undefined}
                      >
                        {artifact.releaseTitle ?? artifact.fingerprint}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatBytes(artifact.bytes)}
                    </td>
                    <td
                      className="px-3 py-2 text-right tabular-nums text-muted-foreground"
                      title={artifact.createdUtc ?? undefined}
                    >
                      {timeAgo(artifact.createdUtc)}
                    </td>
                    <td
                      className="px-3 py-2 text-right tabular-nums text-muted-foreground"
                      title={artifact.lastAccessUtc ?? undefined}
                    >
                      {timeAgo(artifact.lastAccessUtc)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {artifact.pinCount ?? 0}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function RepairArtifactCard({ artifact }: { artifact: RepairArtifactResponse }) {
  return (
    <Card role="listitem">
      <CardContent className="space-y-3 p-4">
        <p className="[overflow-wrap:anywhere] font-mono text-xs font-medium">
          {artifact.releaseTitle ?? artifact.fingerprint ?? "unknown artifact"}
        </p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t pt-3 text-xs">
          <Metric label="Size">{formatBytes(artifact.bytes)}</Metric>
          <Metric label="Pins">{artifact.pinCount ?? 0}</Metric>
          <Metric label="Created">{timeAgo(artifact.createdUtc)}</Metric>
          <Metric label="Last access">{timeAgo(artifact.lastAccessUtc)}</Metric>
        </dl>
      </CardContent>
    </Card>
  );
}

function progressPercent(job: RepairJobResponse): number {
  if (job.progressPercent != null) return Math.max(0, Math.min(100, job.progressPercent));
  if (job.totalBytes && job.totalBytes > 0) {
    return Math.max(0, Math.min(100, Math.round(((job.processedBytes ?? 0) / job.totalBytes) * 100)));
  }
  return 0;
}

function sortedEvents(job: RepairJobResponse): NonNullable<RepairJobResponse["events"]> {
  return [...(job.events ?? [])].sort(
    (a, b) => new Date(a.atUtc ?? 0).getTime() - new Date(b.atUtc ?? 0).getTime(),
  );
}

function withEventKeys(events: NonNullable<RepairJobResponse["events"]>) {
  const occurrences = new Map<string, number>();
  return events.map((event) => {
    const contentKey = JSON.stringify([
      event.atUtc ?? null,
      event.state ?? null,
      event.message ?? null,
    ]);
    const occurrence = occurrences.get(contentKey) ?? 0;
    occurrences.set(contentKey, occurrence + 1);
    return { event, key: `${contentKey}:${occurrence}` };
  });
}

/** Event timestamps stay absolute (UTC, second precision) — this is a debugging log. */
function eventTime(iso?: string | null): string {
  if (!iso) return "—";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  return at.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}
