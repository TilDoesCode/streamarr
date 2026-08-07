import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowUpRight, History, Loader2, Radio, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { HealthBadge } from "@/components/resolve-outcome";
import { useCloseSession, useSessions, useStreamRecords } from "@/api/queries";
import type { SessionResponse, StreamRecordSummaryResponse } from "@/api/types";
import { errorMessage } from "@/api/client";
import { cn, formatBytes, timeAgo } from "@/lib/utils";

export function SessionsPage() {
  const [view, setView] = useState<"live" | "history">("live");
  const live = useSessions({ enabled: view === "live" });
  const history = useStreamRecords(50, { enabled: view === "history" });
  const sessions = live.data ?? [];

  const totalConns = sessions.reduce((n, s) => n + (s.nntpConnectionsInFlight ?? 0), 0);
  const totalBytes = sessions.reduce((n, s) => n + (s.bytesServed ?? 0), 0);
  const isFetching = view === "live" ? live.isFetching : history.isFetching;

  return (
    <div className="space-y-4">
      <div className="flex flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-xl font-semibold tracking-tight">Sessions</h2>
          {isFetching && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        </div>
        {view === "live" && (
          <span className="text-sm text-muted-foreground sm:ml-auto">
            {sessions.length} live · {totalConns} NNTP conns · {formatBytes(totalBytes)} served
          </span>
        )}
      </div>

      <div className="flex items-center gap-1 rounded-lg border bg-muted/40 p-1 text-sm" role="tablist" aria-label="Session view">
        <ViewTab active={view === "live"} onClick={() => setView("live")} icon={<Radio className="size-3.5" />}>
          Live
        </ViewTab>
        <ViewTab active={view === "history"} onClick={() => setView("history")} icon={<History className="size-3.5" />}>
          History
        </ViewTab>
      </div>

      {view === "live" ? (
        <>
          <p className="text-sm text-muted-foreground">
            Live sessions polled every few seconds: release, bytes served, NNTP connections held,
            and originating front-end. Force-close tears a session down immediately (BRIEF
            §9.1.7).
          </p>
          <LiveSessionsTable state={live} sessions={sessions} />
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            The last {history.data?.length ?? 50} retained streams — live or long since closed,
            even ones that never opened a session — for debugging after the fact. Open one to see
            its full diagnostic event log (BRIEF §11).
          </p>
          <HistoryTable state={history} />
        </>
      )}
    </div>
  );
}

function ViewTab({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition-colors",
        active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function LiveSessionsTable({
  state,
  sessions,
}: {
  state: { isLoading: boolean; isError: boolean; error: unknown };
  sessions: SessionResponse[];
}) {
  if (state.isLoading) return <div className="h-40 w-full animate-pulse rounded-lg bg-muted" />;

  if (state.isError) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 pt-6 text-sm text-destructive">
          <AlertTriangle className="size-4" />
          {errorMessage(state.error)}
        </CardContent>
      </Card>
    );
  }

  if (sessions.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <Radio className="size-6" />
          </span>
          <p className="max-w-md text-sm text-muted-foreground">
            No live sessions. Resolve a release from the Search / Debug playground or the Playback
            preview to open one.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border" role="region" aria-label="Live sessions" tabIndex={0}>
      <table className="min-w-[48rem] w-full text-sm">
        <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
          <tr>
            <th className="sticky left-0 bg-muted px-3 py-2">
              <span className="sr-only">Actions</span>
            </th>
            <th className="px-3 py-2 text-left font-medium">Release</th>
            <th className="px-3 py-2 text-left font-medium">State</th>
            <th className="px-3 py-2 text-left font-medium">Source</th>
            <th className="px-3 py-2 text-right font-medium">Bytes served</th>
            <th className="px-3 py-2 text-right font-medium">NNTP</th>
            <th className="px-3 py-2 text-right font-medium">Age</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <SessionRow key={s.token} session={s} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HistoryTable({
  state,
}: {
  state: { data?: StreamRecordSummaryResponse[]; isLoading: boolean; isError: boolean; error: unknown };
}) {
  if (state.isLoading) return <div className="h-40 w-full animate-pulse rounded-lg bg-muted" />;

  if (state.isError) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 pt-6 text-sm text-destructive">
          <AlertTriangle className="size-4" />
          {errorMessage(state.error)}
        </CardContent>
      </Card>
    );
  }

  const records = state.data ?? [];
  if (records.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <History className="size-6" />
          </span>
          <p className="max-w-md text-sm text-muted-foreground">
            Nothing retained yet. Every resolve attempt — successful or failed — shows up here
            once it happens.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border" role="region" aria-label="Retained stream history" tabIndex={0}>
      <table className="min-w-[52rem] w-full text-sm">
        <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
          <tr>
            <th className="sticky left-0 bg-muted px-3 py-2">
              <span className="sr-only">Inspect</span>
            </th>
            <th className="px-3 py-2 text-left font-medium">Release</th>
            <th className="px-3 py-2 text-left font-medium">Final state</th>
            <th className="px-3 py-2 text-left font-medium">Close reason</th>
            <th className="px-3 py-2 text-left font-medium">Source</th>
            <th className="px-3 py-2 text-right font-medium">Bytes served</th>
            <th className="px-3 py-2 text-right font-medium">Created</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r) => (
            <HistoryRow key={r.token} record={r} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HistoryRow({ record }: { record: StreamRecordSummaryResponse }) {
  return (
    <tr className="group border-t transition-colors hover:bg-muted/35">
      <td className="sticky left-0 bg-card px-3 py-2 text-right shadow-[8px_0_12px_-12px_hsl(var(--foreground))]">
        <Button asChild size="sm" variant="outline" aria-label={`Inspect stream ${record.releaseId ?? record.token ?? ""}`}>
          <Link to="/sessions/$sessionToken" params={{ sessionToken: record.token ?? "" }}>
            <ArrowUpRight className="size-4" />
            Inspect
          </Link>
        </Button>
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-col gap-0.5">
          <Link
            to="/sessions/$sessionToken"
            params={{ sessionToken: record.token ?? "" }}
            className="max-w-[22rem] truncate font-mono text-xs font-medium underline-offset-4 transition-colors hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={record.releaseId ?? undefined}
          >
            {record.title || record.releaseId}
          </Link>
          {record.container && <span className="text-xs text-muted-foreground">{record.container}</span>}
        </div>
      </td>
      <td className="px-3 py-2">
        <HealthBadge status={record.finalState ?? "open"} />
      </td>
      <td className="px-3 py-2 max-w-[16rem] truncate text-xs text-muted-foreground" title={record.closeReason ?? ""}>
        {record.closeReason || "—"}
      </td>
      <td className="px-3 py-2">
        <Badge variant="muted">{record.client ?? "unknown"}</Badge>
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{formatBytes(record.bytesServed)}</td>
      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{timeAgo(record.createdAt)}</td>
    </tr>
  );
}

function SessionRow({ session }: { session: SessionResponse }) {
  const close = useCloseSession();
  const [confirming, setConfirming] = useState(false);

  async function forceClose() {
    if (!session.token) return;
    try {
      await close.mutateAsync(session.token);
      toast.success("Session closed.");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setConfirming(false);
    }
  }

  const pct =
    session.sizeBytes && session.sizeBytes > 0
      ? Math.min(100, Math.round(((session.bytesServed ?? 0) / session.sizeBytes) * 100))
      : null;

  return (
    <tr className="group border-t transition-colors hover:bg-muted/35">
      <td className="sticky left-0 bg-card px-3 py-2 text-right shadow-[8px_0_12px_-12px_hsl(var(--foreground))]">
        {confirming ? (
          <div className="flex items-center justify-end gap-1">
            <Button size="sm" variant="destructive" onClick={forceClose} disabled={close.isPending}>
              {close.isPending && <Loader2 className="size-4 animate-spin" />}
              Confirm
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={close.isPending}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setConfirming(true)}
            aria-label={`Force-close session ${session.releaseId ?? ""}`}
          >
            <XCircle className="size-4" />
            Close
          </Button>
        )}
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-col gap-0.5">
          <Link
            to="/sessions/$sessionToken"
            params={{ sessionToken: session.token ?? "" }}
            className="flex max-w-[22rem] items-center gap-1.5 truncate font-mono text-xs font-medium underline-offset-4 transition-colors hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={session.releaseId ?? ""}
            aria-label={`Inspect stream ${session.releaseId ?? ""}`}
          >
            <span className="truncate">{session.releaseId}</span>
            <ArrowUpRight className="size-3 shrink-0 opacity-40 transition-opacity group-hover:opacity-100" />
          </Link>
          {session.container && (
            <span className="text-xs text-muted-foreground">{session.container}</span>
          )}
        </div>
      </td>
      <td className="px-3 py-2">
        <HealthBadge status={session.state} />
      </td>
      <td className="px-3 py-2">
        <Badge variant="muted">{session.client ?? "unknown"}</Badge>
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {formatBytes(session.bytesServed)}
        {pct != null && <span className="ml-1 text-xs text-muted-foreground">({pct}%)</span>}
      </td>
      <td className="px-3 py-2 text-right tabular-nums" title={`${session.nntpCommandsTotal ?? 0} commands total`}>
        {session.nntpConnectionsInFlight ?? 0}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
        {timeAgo(session.createdAt)}
      </td>
    </tr>
  );
}
