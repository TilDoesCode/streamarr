import { useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CalendarDays, CheckCheck, ListVideo, Loader2, Play, RotateCcw, Undo2, X } from "lucide-react";
import { toast } from "sonner";
import type { NextUpResponse, WatchHistoryResponse, WatchStateResponse } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { episodeLabel, ticksToSeconds } from "@/lib/viewers";
import { Hint, InlineError, LoadingBlock, Panel } from "../shared";
import { WatchStateRow } from "../viewer-dialogs";
import type { PlayerLoad } from "./player-simulator";
import { harnessKeys, useHarness, useInvalidateWatch, useSessionId } from "./use-harness";

type Load = Omit<PlayerLoad, "nonce">;

export function WatchLists({ onLoad }: { onLoad: (load: Load) => void }) {
  const { client } = useHarness();
  const sid = useSessionId();
  const [tab, setTab] = useState("resume");
  const resume = useQuery({ queryKey: harnessKeys.resume(sid), queryFn: () => client.resume(20), retry: false });
  const nextUp = useQuery({ queryKey: harnessKeys.nextUp(sid), queryFn: () => client.nextUp({ limit: 20 }), retry: false });
  const history = useQuery({ queryKey: harnessKeys.history(sid), queryFn: () => client.history({ limit: 50 }), retry: false });

  return (
    <Panel
      icon={<ListVideo />}
      title="Watch lists"
      description="What a viewer app shows on its home screen. Refreshed after every report or mark."
    >
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-auto w-full flex-wrap justify-start sm:w-auto">
          <TabsTrigger value="resume">Continue watching{resume.data ? ` (${resume.data.length})` : ""}</TabsTrigger>
          <TabsTrigger value="next">Next up{nextUp.data?.items ? ` (${nextUp.data.items.length})` : ""}</TabsTrigger>
          <TabsTrigger value="history">History{history.data ? ` (${history.data.total})` : ""}</TabsTrigger>
        </TabsList>
        <TabsContent value="resume">
          <ContinueWatching query={resume} onLoad={onLoad} />
        </TabsContent>
        <TabsContent value="next">
          <NextUp query={nextUp} onLoad={onLoad} />
        </TabsContent>
        <TabsContent value="history">
          <HistoryList query={history} />
        </TabsContent>
      </Tabs>
      <MarkPlayedForm />
    </Panel>
  );
}

interface QueryLike<T> {
  data?: T;
  isLoading: boolean;
  error: unknown;
}

function ListState<T>({ query, children }: { query: QueryLike<T>; children: ReactNode }) {
  if (query.isLoading) return <LoadingBlock label="Loading" className="h-24" />;
  if (query.error) return <InlineError error={query.error} />;
  return <>{children}</>;
}

function EmptyList({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">{children}</p>;
}

function ContinueWatching({ query, onLoad }: { query: QueryLike<WatchStateResponse[]>; onLoad: (load: Load) => void }) {
  const { client } = useHarness();
  const invalidate = useInvalidateWatch();
  const remove = useMutation({
    mutationFn: (workId: string) => client.removeFromResume(workId),
    onSuccess: () => invalidate(),
    onError: (error) => toast.error(error.message),
  });
  const items = query.data ?? [];
  return (
    <ListState query={query}>
        {items.length === 0 ? (
          <EmptyList>Nothing to continue. Stop a playback between the resume and played thresholds.</EmptyList>
        ) : (
          <ul className="divide-y rounded-lg border" aria-label="Continue watching">
            {items.map((item) => (
              <WatchStateRow
                key={item.workId}
                item={item}
                action={
                  <span className="flex gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        onLoad({
                          workId: item.workId ?? "",
                          title: item.title ?? undefined,
                          durationSeconds: ticksToSeconds(item.durationTicks) || undefined,
                          positionSeconds: ticksToSeconds(item.positionTicks),
                        })
                      }
                      aria-label={`Resume ${item.title || item.workId}`}
                    >
                      <Play />Resume
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => remove.mutate(item.workId ?? "")}
                      disabled={remove.isPending}
                      aria-label={`Remove ${item.title || item.workId} from continue watching`}
                    >
                      <X />Remove
                    </Button>
                  </span>
                }
              />
            ))}
          </ul>
        )}
    </ListState>
  );
}

function NextUp({ query, onLoad }: { query: QueryLike<NextUpResponse>; onLoad: (load: Load) => void }) {
  const items = query.data?.items ?? [];
  return (
    <ListState query={query}>
      <div className="space-y-2">
        {query.data?.incomplete && (
          <Hint tone="warning">Incomplete: TMDB could not be asked about some series, so their next episode is missing.</Hint>
        )}
        {items.length === 0 ? (
          <EmptyList>No next episodes. Finish an episode (e.g. Breaking Bad S01E01) to see the following one here.</EmptyList>
        ) : (
          <ul className="divide-y rounded-lg border" aria-label="Next up">
            {items.map((item) => {
              const label = episodeLabel(item.seasonNumber, item.episodeNumber);
              return (
                <li key={item.workId} className="flex flex-wrap items-center gap-3 p-3">
                  <div className="min-w-0 flex-1 basis-56">
                    <p className="truncate text-sm font-medium">{item.seriesTitle || item.seriesWorkId}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      <span className="font-mono">{label}</span>
                      {item.episodeTitle ? ` · ${item.episodeTitle}` : ""}
                    </p>
                    <p className="flex flex-wrap items-center gap-x-2 font-mono text-[11px] text-muted-foreground">
                      <span>{item.workId}</span>
                      {item.airDate && (
                        <span className="inline-flex items-center gap-1"><CalendarDays className="size-3" aria-hidden />{item.airDate}</span>
                      )}
                      {item.runtimeMinutes ? <span>{item.runtimeMinutes} min</span> : null}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      onLoad({
                        workId: item.workId ?? "",
                        title: `${item.seriesTitle ?? ""} ${label}`.trim(),
                        durationSeconds: item.runtimeMinutes ? item.runtimeMinutes * 60 : ticksToSeconds(item.durationTicks) || undefined,
                        positionSeconds: ticksToSeconds(item.positionTicks),
                      })
                    }
                    aria-label={`Play ${item.seriesTitle} ${label}`}
                  >
                    <Play />Play
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </ListState>
  );
}

function HistoryList({ query }: { query: QueryLike<WatchHistoryResponse> }) {
  const { client } = useHarness();
  const invalidate = useInvalidateWatch();
  const unplayed = useMutation({
    mutationFn: (workId: string) => client.markUnplayed([workId]),
    onSuccess: () => invalidate(),
    onError: (error) => toast.error(error.message),
  });
  const items = query.data?.items ?? [];
  return (
    <ListState query={query}>
      {items.length === 0 ? (
        <EmptyList>No history yet. Every started or played title shows up here.</EmptyList>
      ) : (
        <ul className="divide-y rounded-lg border" aria-label="History">
          {items.map((item) => (
            <WatchStateRow
              key={item.workId}
              item={item}
              action={
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => unplayed.mutate(item.workId ?? "")}
                  disabled={unplayed.isPending}
                  aria-label={`Mark ${item.title || item.workId} unplayed`}
                >
                  <Undo2 />Mark unplayed
                </Button>
              }
            />
          ))}
        </ul>
      )}
    </ListState>
  );
}

function MarkPlayedForm() {
  const { client } = useHarness();
  const invalidate = useInvalidateWatch();
  const [value, setValue] = useState("");
  const ids = value.split(/[\s,]+/).map((id) => id.trim()).filter(Boolean);
  const mark = useMutation({
    mutationFn: (played: boolean) => (played ? client.markPlayed(ids) : client.markUnplayed(ids)),
    onSuccess: (result) => {
      invalidate();
      const count = result?.workIds?.length ?? 0;
      toast.success(`${count} item${count === 1 ? "" : "s"} marked ${result?.played ? "played" : "unplayed"}.`);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (ids.length) mark.mutate(true);
  }

  return (
    <form onSubmit={submit} className="space-y-2 border-t pt-4" aria-label="Mark played">
      <Label htmlFor="mark-played-ids">Mark played / unplayed</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id="mark-played-ids"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="tmdb-movie-603, tmdb-tv-1396-s02, tmdb-tv-66732"
          spellCheck={false}
          className="font-mono text-xs"
          aria-describedby="mark-played-hint"
        />
        <div className="flex gap-2">
          <Button type="submit" size="sm" className="h-9" disabled={!ids.length || mark.isPending}>
            {mark.isPending ? <Loader2 className="animate-spin" /> : <CheckCheck />}
            Mark played
          </Button>
          <Button type="button" size="sm" variant="outline" className="h-9" disabled={!ids.length || mark.isPending} onClick={() => mark.mutate(false)}>
            <RotateCcw />Unplayed
          </Button>
        </div>
      </div>
      <p id="mark-played-hint" className="text-xs leading-5 text-muted-foreground">
        Movie and episode ids, or a season (<code className="font-mono">tmdb-tv-1396-s02</code>) / series (<code className="font-mono">tmdb-tv-1396</code>) id
        — those expand to every aired episode via TMDB.
      </p>
      <InlineError error={mark.error} />
    </form>
  );
}
