import { Activity, AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useHealth } from "@/api/queries";
import { errorMessage } from "@/api/client";

/**
 * Minimal dashboard: liveness + per-indexer/per-provider reachability from GET /health,
 * polled on an interval. The richer dashboard (throughput chart, live sessions, recent
 * resolves — BRIEF §9.1) is a later M4 task.
 */
export function DashboardPage() {
  const { data, isLoading, isError, error, isFetching } = useHealth();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <h2 className="text-xl font-semibold tracking-tight">Dashboard</h2>
        {isFetching && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      </div>

      {isLoading ? (
        <div className="h-32 w-full animate-pulse rounded-lg bg-muted" />
      ) : isError ? (
        <Card>
          <CardContent className="flex items-center gap-2 pt-6 text-sm text-destructive">
            <AlertTriangle className="size-4" />
            {errorMessage(error)}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="size-4" />
              Service health
              <StatusBadge status={data?.status ?? "unknown"} />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              The Core Server is reachable and responding. Indexer and provider reachability
              detail, live sessions, and throughput charts arrive with the full dashboard view.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const ok = status.toLowerCase() === "healthy" || status.toLowerCase() === "ok";
  return (
    <Badge variant={ok ? "success" : "muted"} className="ml-auto gap-1">
      {ok ? <CheckCircle2 className="size-3" /> : <AlertTriangle className="size-3" />}
      {status}
    </Badge>
  );
}
