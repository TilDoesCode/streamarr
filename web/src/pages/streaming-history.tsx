import { useMemo, useState } from "react";
import { CheckCircle2, CircleUserRound, Clock3, History, MonitorPlay, Search, Square } from "lucide-react";
import { useCachedReleases, useStreamingHistory } from "@/api/queries";
import type { StreamingHistoryResponse } from "@/api/types";
import { errorMessage } from "@/api/client";
import { EmptyOpsState, OpsHero, OpsMetric, OpsMetrics } from "@/components/ops-page";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { formatTicks, timeAgo } from "@/lib/utils";

interface PlaybackVisit {
  key: string;
  releaseId: string;
  workId: string;
  title: string;
  source: string;
  userId?: string;
  userName?: string;
  device?: string;
  startedAt: string;
  updatedAt: string;
  positionTicks: number;
  state: string;
  eventCount: number;
}

export function StreamingHistoryPage() {
  const history = useStreamingHistory();
  const library = useCachedReleases();
  const [filter, setFilter] = useState("");
  const [state, setState] = useState("all");
  const titleByRelease = useMemo(
    () => new Map((library.data ?? []).flatMap((release) =>
      release.releaseId && release.title ? [[release.releaseId, release.title] as const] : [],
    )),
    [library.data],
  );
  const visits = useMemo(
    () => aggregate(history.data ?? [], titleByRelease),
    [history.data, titleByRelease],
  );
  const visible = useMemo(() => {
    const needle = filter.trim().toLocaleLowerCase();
    return visits.filter((visit) =>
      (state === "all" || visit.state === state) &&
      (!needle || [visit.title, visit.releaseId, visit.userName, visit.userId, visit.device]
        .some((value) => value?.toLocaleLowerCase().includes(needle))),
    );
  }, [filter, state, visits]);
  const users = new Set(visits.map((visit) => visit.userId || visit.userName).filter(Boolean)).size;
  const completed = visits.filter((visit) => visit.state === "stop").length;
  const latest = visits[0];

  return (
    <div className="space-y-5">
      <OpsHero
        eyebrow="Jellyfin playback events"
        title="Streaming history"
        description="Start, progress, and stop events are grouped by Jellyfin playback-session ID. Each row shows the external user, device, last reported position, and number of stored events."
        accent="lime"
      >
        <OpsMetrics>
          <OpsMetric label="Sessions" value={String(visits.length)} detail="grouped playback IDs" />
          <OpsMetric label="Jellyfin users" value={String(users)} detail="distinct external users" />
          <OpsMetric label="Stopped sessions" value={String(completed)} detail={`${visits.length ? Math.round(completed / visits.length * 100) : 0}% of sessions`} />
          <OpsMetric label="Last event" value={latest ? timeAgo(latest.updatedAt) : "—"} detail={latest?.userName ?? "no events stored"} />
        </OpsMetrics>
      </OpsHero>

      <div className="grid gap-3 rounded-xl border bg-card p-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter title, Jellyfin user, device or release…" className="pl-9" aria-label="Filter streaming history" />
        </div>
        <select value={state} onChange={(event) => setState(event.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring" aria-label="Filter playback state">
          <option value="all">All states</option>
          <option value="start">Playing / started</option>
          <option value="progress">In progress</option>
          <option value="stop">Stopped</option>
        </select>
      </div>

      {history.isLoading ? (
        <div className="space-y-3">{[0, 1, 2, 3].map((key) => <div key={key} className="h-28 animate-pulse rounded-xl bg-muted" />)}</div>
      ) : history.isError ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive">{errorMessage(history.error)}</div>
      ) : visits.length === 0 ? (
        <EmptyOpsState icon={<History className="size-5" />} title="No playback history yet" description="Start a Streamarr item in Jellyfin. Core will record the Jellyfin user and device alongside start, progress, and stop events." />
      ) : (
        <div className="relative space-y-3 before:absolute before:bottom-10 before:left-[1.95rem] before:top-10 before:w-px before:bg-border sm:before:left-[2.45rem]">
          {visible.map((visit) => <HistoryRow key={visit.key} visit={visit} />)}
        </div>
      )}
    </div>
  );
}

function HistoryRow({ visit }: { visit: PlaybackVisit }) {
  const stopped = visit.state === "stop";
  const initial = (visit.userName || "?").trim().charAt(0).toUpperCase();
  return (
    <article className="relative grid grid-cols-[4rem_minmax(0,1fr)] overflow-hidden rounded-xl border bg-card transition-colors hover:border-lime-500/40 sm:grid-cols-[5rem_minmax(0,1fr)_12rem]">
      <div className="z-10 flex items-center justify-center border-r bg-card">
        <div className="flex size-10 items-center justify-center rounded-full border-4 border-card bg-lime-400 font-mono text-sm font-bold text-lime-950 shadow-sm">{initial}</div>
      </div>
      <div className="min-w-0 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="max-w-2xl truncate font-semibold" title={visit.title}>{visit.title}</h3>
          <Badge variant={stopped ? "muted" : "success"} className="gap-1 uppercase">
            {stopped ? <Square className="size-2.5 fill-current" /> : <span className="size-1.5 rounded-full bg-current" />}
            {stopped ? "stopped" : "active"}
          </Badge>
          <Badge variant="outline" className="uppercase">{visit.source}</Badge>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5 text-foreground"><CircleUserRound className="size-3.5 text-muted-foreground" />{visit.userName || "Unknown Jellyfin user"}</span>
          <span className="flex items-center gap-1.5"><MonitorPlay className="size-3.5" />{visit.device || "Unknown device"}</span>
          <span className="flex items-center gap-1.5"><Clock3 className="size-3.5" />started {timeAgo(visit.startedAt)}</span>
        </div>
        <p className="mt-3 truncate font-mono text-[10px] text-muted-foreground" title={visit.releaseId}>{visit.releaseId}</p>
      </div>
      <div className="col-span-2 flex items-center justify-between gap-4 border-t bg-muted/20 px-4 py-3 sm:col-span-1 sm:flex-col sm:items-end sm:justify-center sm:border-l sm:border-t-0 sm:px-5">
        <div className="sm:text-right">
          <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Last position</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">{formatTicks(visit.positionTicks)}</p>
        </div>
        <p className="flex items-center gap-1 text-[11px] text-muted-foreground"><CheckCircle2 className="size-3.5" />{visit.eventCount} events</p>
      </div>
    </article>
  );
}

function aggregate(events: StreamingHistoryResponse[], titles: Map<string, string>): PlaybackVisit[] {
  const groups = new Map<string, StreamingHistoryResponse[]>();
  for (const event of events) {
    const key = event.playbackSessionId || `${event.source ?? "unknown"}:${event.externalUserId || "unknown"}:${event.releaseId ?? "unknown"}`;
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }

  return [...groups.entries()].map(([key, entries]) => {
    const ordered = [...entries].sort((a, b) => Date.parse(a.receivedAt ?? "") - Date.parse(b.receivedAt ?? ""));
    const first = ordered[0];
    const last = ordered.at(-1)!;
    return {
      key,
      releaseId: last.releaseId ?? "unknown release",
      workId: last.workId ?? "unknown work",
      title: titles.get(last.releaseId ?? "") || last.workId || last.releaseId || "Unknown release",
      source: last.source ?? "unknown",
      userId: last.externalUserId ?? undefined,
      userName: last.externalUserName ?? undefined,
      device: last.deviceName ?? undefined,
      startedAt: first.receivedAt ?? "",
      updatedAt: last.receivedAt ?? "",
      positionTicks: Math.max(...ordered.map((event) => event.positionTicks ?? 0)),
      state: last.event ?? "progress",
      eventCount: ordered.length,
    };
  }).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}
