import { useState } from "react";
import { AlertTriangle, Loader2, Radio, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { HealthBadge } from "@/components/resolve-outcome";
import { useCloseSession, useSessions } from "@/api/queries";
import type { SessionResponse } from "@/api/types";
import { errorMessage } from "@/api/client";
import { formatBytes, timeAgo } from "@/lib/utils";

export function SessionsPage() {
  const { data, isLoading, isError, error, isFetching } = useSessions();
  const sessions = data ?? [];

  const totalConns = sessions.reduce((n, s) => n + (s.nntpConnectionsInFlight ?? 0), 0);
  const totalBytes = sessions.reduce((n, s) => n + (s.bytesServed ?? 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="text-xl font-semibold tracking-tight">Sessions</h2>
        {isFetching && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        <span className="ml-auto text-sm text-muted-foreground">
          {sessions.length} live · {totalConns} NNTP conns · {formatBytes(totalBytes)} served
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        Live sessions polled every few seconds: release, bytes served, NNTP connections held, and
        originating front-end. Force-close tears a session down immediately (BRIEF §9.1.7).
      </p>

      {isLoading ? (
        <div className="h-40 w-full animate-pulse rounded-lg bg-muted" />
      ) : isError ? (
        <Card>
          <CardContent className="flex items-center gap-2 pt-6 text-sm text-destructive">
            <AlertTriangle className="size-4" />
            {errorMessage(error)}
          </CardContent>
        </Card>
      ) : sessions.length === 0 ? (
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
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Release</th>
                <th className="px-3 py-2 text-left font-medium">State</th>
                <th className="px-3 py-2 text-left font-medium">Source</th>
                <th className="px-3 py-2 text-right font-medium">Bytes served</th>
                <th className="px-3 py-2 text-right font-medium">NNTP</th>
                <th className="px-3 py-2 text-right font-medium">Age</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <SessionRow key={s.token} session={s} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
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
    <tr className="border-t">
      <td className="px-3 py-2">
        <div className="flex flex-col gap-0.5">
          <span className="truncate font-mono text-xs" title={session.releaseId ?? ""}>
            {session.releaseId}
          </span>
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
      <td className="px-3 py-2 text-right">
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
    </tr>
  );
}
