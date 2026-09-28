import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, Film, Loader2, Pause, Play, Search, ShieldQuestion, SkipForward, Square, Tv } from "lucide-react";
import { useTvSeriesSearch, useViewerSettings } from "@/api/queries";
import type { ContentAccessResponse, WatchStateResponse } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn, formatTicks, timeAgo } from "@/lib/utils";
import {
  accessReasonLabel,
  episodeLabel,
  episodeWorkId,
  formatClock,
  parseWorkId,
  randomId,
  secondsToTicks,
} from "@/lib/viewers";
import { InlineError, Panel, ProgressBar, TextField, ToneBadge } from "../shared";
import { useHarness, useInvalidateWatch } from "./use-harness";

export interface PlayerLoad {
  workId: string;
  title?: string;
  durationSeconds?: number;
  positionSeconds?: number;
  nonce: number;
}

type WatchEvent = "start" | "progress" | "stop";

const PRESETS = [
  { workId: "tmdb-movie-603", title: "The Matrix" },
  { workId: "tmdb-movie-27205", title: "Inception" },
  { workId: "tmdb-tv-1396-s01e01", title: "Breaking Bad S01E01" },
  { workId: "tmdb-tv-66732-s01e01", title: "Stranger Things S01E01" },
];
const SPEEDS = [1, 10, 60] as const;
const REPORT_EVERY_MS = 5_000;
const TICK_MS = 1_000;

function defaultMinutes(workId: string): number {
  return parseWorkId(workId)?.kind === "movie" ? 120 : 45;
}

export function PlayerSimulator({ load }: { load: PlayerLoad | null }) {
  const { client } = useHarness();
  const invalidate = useInvalidateWatch();
  const settings = useViewerSettings();
  const [workId, setWorkId] = useState(PRESETS[0].workId);
  const [title, setTitle] = useState(PRESETS[0].title);
  const [minutes, setMinutes] = useState(String(defaultMinutes(PRESETS[0].workId)));
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(10);
  const [playbackId, setPlaybackId] = useState<string | null>(null);
  const [state, setState] = useState<WatchStateResponse | null>(null);
  const [lastEvent, setLastEvent] = useState<WatchEvent | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [sending, setSending] = useState(0);
  const [series, setSeries] = useState({ id: "1396", season: "1", episode: "1", name: "Breaking Bad" });
  const sectionRef = useRef<HTMLElement>(null);

  const parsed = parseWorkId(workId);
  const playable = parsed?.kind === "movie" || parsed?.kind === "episode";
  const duration = Math.max(60, Math.round((Number(minutes) || defaultMinutes(workId)) * 60));
  const percent = Math.min(100, (position / duration) * 100);

  // The interval and unmount cleanup read the latest values through this ref.
  const live = useRef({ workId, title, duration, position, playbackId, playing, speed });
  live.current = { workId, title, duration, position, playbackId, playing, speed };

  async function report(event: WatchEvent, overrides: { position?: number; playbackId?: string | null } = {}) {
    const current = live.current;
    const at = overrides.position ?? current.position;
    const id = overrides.playbackId !== undefined ? overrides.playbackId : current.playbackId;
    setSending((count) => count + 1);
    try {
      const result = await client.progress({
        event,
        workId: current.workId.trim(),
        positionTicks: secondsToTicks(at),
        durationTicks: secondsToTicks(current.duration),
        playbackId: id ?? undefined,
        title: current.title.trim() || undefined,
      });
      setState(result);
      setLastEvent(event);
      setError(null);
      invalidate();
      return true;
    } catch (failure) {
      setError(failure);
      setPlaying(false);
      return false;
    } finally {
      setSending((count) => count - 1);
    }
  }
  const reportRef = useRef(report);
  reportRef.current = report;

  function select(next: { workId: string; title?: string; durationSeconds?: number; positionSeconds?: number }) {
    setPlaying(false);
    setPlaybackId(null);
    setState(null);
    setLastEvent(null);
    setError(null);
    access.reset();
    setWorkId(next.workId);
    setTitle(next.title ?? "");
    setMinutes(String(next.durationSeconds ? Math.max(1, Math.round(next.durationSeconds / 60)) : defaultMinutes(next.workId)));
    setPosition(Math.max(0, next.positionSeconds ?? 0));
  }

  // Apply each load request (Resume / Play from the lists) exactly once.
  useEffect(() => {
    if (!load) return;
    select(load);
    sectionRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, [load?.nonce]);

  useEffect(() => {
    if (!playing) return;
    let sinceReport = 0;
    const handle = window.setInterval(() => {
      const current = live.current;
      const next = Math.min(current.duration, current.position + current.speed * (TICK_MS / 1_000));
      live.current.position = next;
      setPosition(next);
      sinceReport += TICK_MS;
      if (next >= current.duration) {
        setPlaying(false);
        void reportRef.current("stop", { position: next });
        setPlaybackId(null);
      } else if (sinceReport >= REPORT_EVERY_MS) {
        sinceReport = 0;
        void reportRef.current("progress", { position: next });
      }
    }, TICK_MS);
    return () => window.clearInterval(handle);
  }, [playing]);

  // A real player reports "stop" when it is closed mid-playback.
  useEffect(
    () => () => {
      const current = live.current;
      if (!current.playing || !current.playbackId) return;
      void client
        .progress({
          event: "stop",
          workId: current.workId.trim(),
          positionTicks: secondsToTicks(current.position),
          durationTicks: secondsToTicks(current.duration),
          playbackId: current.playbackId,
          title: current.title.trim() || undefined,
        })
        .catch(() => undefined);
    },
    [client],
  );

  async function start(from = live.current.position) {
    const id = randomId();
    setPlaybackId(id);
    live.current.playbackId = id;
    return report("start", { playbackId: id, position: from });
  }

  async function togglePlay() {
    if (playing) {
      setPlaying(false);
      await report("progress");
      return;
    }
    let from = position;
    if (from >= duration) {
      from = 0;
      setPosition(0);
      live.current.position = 0;
    }
    const ok = live.current.playbackId ? true : await start(from);
    if (ok) setPlaying(true);
  }

  async function stop() {
    setPlaying(false);
    await report("stop");
    setPlaybackId(null);
  }

  async function finish() {
    setPlaying(false);
    const at = duration * 0.95;
    setPosition(at);
    live.current.position = at;
    const id = live.current.playbackId ?? randomId();
    await report("stop", { position: at, playbackId: id });
    setPlaybackId(null);
  }

  const access = useMutation({ mutationFn: () => client.access(workId.trim()) });
  const busy = sending > 0;
  const rules = settings.data;

  return (
    <Panel
      icon={<Film />}
      title="Player simulator"
      description="Reports playback like a real player: start, periodic progress, stop. One random playback id per start, so a finished play counts once."
    >
      <section ref={sectionRef} className="scroll-mt-20 space-y-4" aria-label="Player">
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground" id="player-presets">Presets</p>
          <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby="player-presets">
            {PRESETS.map((preset) => (
              <Button
                key={preset.workId}
                type="button"
                size="sm"
                variant="outline"
                aria-pressed={workId === preset.workId}
                className={cn(workId === preset.workId && "border-cyan-500/60 bg-cyan-500/10")}
                onClick={() => select(preset)}
              >
                {parseWorkId(preset.workId)?.kind === "movie" ? <Film /> : <Tv />}
                {preset.title}
              </Button>
            ))}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,8.5rem)]">
          <TextField
            id="player-work-id"
            label="Work id"
            spellCheck={false}
            className="[&_input]:font-mono"
            value={workId}
            onChange={(event) => {
              setWorkId(event.target.value);
              setPlaybackId(null);
              setPlaying(false);
            }}
            error={workId.trim() && !playable ? "Needs a movie (tmdb-movie-603) or episode (tmdb-tv-1396-s01e01) id" : undefined}
            hint={
              parsed?.kind === "movie"
                ? `Movie · TMDB ${parsed.tmdbId}`
                : parsed?.kind === "episode"
                  ? `Episode ${episodeLabel(parsed.season, parsed.episode)} · TMDB series ${parsed.tmdbId}`
                  : "tmdb-movie-{id} or tmdb-tv-{id}-sNNeNN"
            }
          />
          <TextField id="player-title" label="Title (optional)" value={title} onChange={(event) => setTitle(event.target.value)} />
          <TextField
            id="player-duration"
            label="Duration"
            unit="min"
            type="number"
            inputMode="numeric"
            min={1}
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
          />
        </div>

        <EpisodeHelper series={series} onChange={setSeries} onSelect={(id, label) => select({ workId: id, title: label })} />

        <div className="space-y-2 rounded-lg border bg-muted/20 p-3 dark:bg-zinc-900/40">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <Label htmlFor="player-position">Position</Label>
            <span className="font-mono text-xs tabular-nums text-muted-foreground" aria-live="off">
              {formatClock(position)} / {formatClock(duration)} · {percent.toFixed(1)} %
            </span>
          </div>
          <input
            id="player-position"
            type="range"
            min={0}
            max={100}
            step={0.1}
            value={percent}
            onChange={(event) => {
              const next = (Number(event.target.value) / 100) * duration;
              setPosition(next);
              live.current.position = next;
            }}
            className="w-full accent-cyan-600"
            aria-valuetext={`${formatClock(position)} of ${formatClock(duration)}`}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => void start()} disabled={!playable || busy}>
              <Play />Start
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => void report("progress")} disabled={!playable || busy}>
              Send progress
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => void stop()} disabled={!playable || busy}>
              <Square />Stop
            </Button>
            <Button type="button" size="sm" onClick={() => void togglePlay()} disabled={!playable} aria-pressed={playing}>
              {playing ? <Pause /> : <Play />}
              {playing ? "Pause" : "Play"}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => void finish()} disabled={!playable || busy}>
              <CheckCircle2 />Finish (95 %)
            </Button>
            <div className="flex items-center gap-1" role="group" aria-label="Playback speed">
              {SPEEDS.map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setSpeed(value)}
                  aria-pressed={speed === value}
                  className={cn(
                    "h-8 rounded-md border px-2 font-mono text-xs transition-colors hover:bg-accent",
                    speed === value && "border-cyan-500/60 bg-cyan-500/10 text-cyan-900 dark:text-cyan-100",
                  )}
                >
                  {value}×
                </button>
              ))}
            </div>
            {busy && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Sending report" />}
          </div>
          <p className="text-[11px] leading-5 text-muted-foreground">
            {playing
              ? `Playing at ${speed}× — a progress report goes out every ${REPORT_EVERY_MS / 1_000} s.`
              : playbackId
                ? `Paused · playback ${playbackId.slice(0, 8)}…`
                : "Not playing. Play starts a new playback (with a start report)."}
            {rules &&
              ` Server rules: below ${rules.minResumePercent} % no resume point, from ${rules.playedPercent} % played, items under ${Math.round(rules.minResumeDurationSeconds / 60)} min never resume.`}
          </p>
        </div>

        <InlineError error={error} />
        {state && <StateSummary state={state} event={lastEvent} />}

        <div className="flex flex-wrap items-start gap-3 border-t pt-3">
          <Button type="button" size="sm" variant="outline" onClick={() => access.mutate()} disabled={!parsed || access.isPending}>
            {access.isPending ? <Loader2 className="animate-spin" /> : <ShieldQuestion />}
            Check age gate
          </Button>
          {access.data && <AccessResult result={access.data} />}
          {access.error ? <div className="w-full"><InlineError error={access.error} /></div> : null}
        </div>
      </section>
    </Panel>
  );
}

function EpisodeHelper({
  series,
  onChange,
  onSelect,
}: {
  series: { id: string; season: string; episode: string; name: string };
  onChange: (next: { id: string; season: string; episode: string; name: string }) => void;
  onSelect: (workId: string, title: string) => void;
}) {
  const search = useTvSeriesSearch();
  const [query, setQuery] = useState("");
  const id = Number(series.id);
  const season = Number(series.season);
  const episode = Number(series.episode);
  const valid = Number.isInteger(id) && id > 0 && Number.isInteger(season) && season >= 0 && Number.isInteger(episode) && episode > 0;
  const label = (e: number) => `${series.name ? `${series.name} ` : ""}${episodeLabel(season, e)}`;

  function use(nextEpisode = episode) {
    if (!valid) return;
    onChange({ ...series, episode: String(nextEpisode) });
    onSelect(episodeWorkId(id, season, nextEpisode), label(nextEpisode));
  }

  return (
    <details className="group rounded-lg border">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium hover:bg-muted/40 [&::-webkit-details-marker]:hidden">
        <Tv className="size-3.5 text-cyan-600 dark:text-cyan-400" aria-hidden />
        Episode helper
        <span className="ml-auto font-mono text-[11px] font-normal text-muted-foreground">
          {valid ? episodeWorkId(id, season, episode) : "series id + season + episode"}
        </span>
      </summary>
      <div className="space-y-3 border-t p-3">
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <TextField id="episode-series" label="TMDB series id" type="number" inputMode="numeric" min={1} value={series.id} onChange={(event) => onChange({ ...series, id: event.target.value, name: "" })} />
          <TextField id="episode-season" label="Season" type="number" inputMode="numeric" min={0} value={series.season} onChange={(event) => onChange({ ...series, season: event.target.value })} />
          <TextField id="episode-episode" label="Episode" type="number" inputMode="numeric" min={1} value={series.episode} onChange={(event) => onChange({ ...series, episode: event.target.value })} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => use()} disabled={!valid}>
            <Play />Use episode
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => use(episode + 1)} disabled={!valid}>
            <SkipForward />Next episode
          </Button>
        </div>
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            if (query.trim()) search.mutate({ q: query.trim() });
          }}
          aria-label="Find a series on TMDB"
        >
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a series on TMDB…" aria-label="Series name" className="sm:max-w-xs" />
          <Button type="submit" size="sm" variant="ghost" disabled={!query.trim() || search.isPending}>
            {search.isPending ? <Loader2 className="animate-spin" /> : <Search />}
            Search
          </Button>
        </form>
        {search.error ? <InlineError error={search.error} /> : null}
        {(search.data?.results?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {(search.data?.results ?? []).map((result) => (
              <Button
                key={result.tmdbId}
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onChange({ id: String(result.tmdbId), season: "1", episode: "1", name: result.title ?? "" })}
              >
                {result.title}
                {result.year ? ` (${result.year})` : ""}
                <span className="font-mono text-[11px] text-muted-foreground">#{result.tmdbId}</span>
              </Button>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

function StateSummary({ state, event }: { state: WatchStateResponse; event: WatchEvent | null }) {
  const percent = state.progressPercent ?? 0;
  return (
    <div className="space-y-2 rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-3" aria-label="Server watch state" role="status">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium">Server state after “{event}”</span>
        {state.played ? <ToneBadge tone="success"><CheckCircle2 className="mr-1 size-3" />Played</ToneBadge> : <ToneBadge tone="muted">Not played</ToneBadge>}
        <ToneBadge tone="info">Play count {state.playCount ?? 0}</ToneBadge>
      </div>
      <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <Fact label="Resume point" value={(state.positionTicks ?? 0) > 0 ? formatTicks(state.positionTicks) : "none"} />
        <Fact label="Progress" value={`${percent.toFixed(1)} %`} />
        <Fact label="Duration" value={formatTicks(state.durationTicks)} />
        <Fact label="Last played" value={state.lastPlayedAt ? timeAgo(state.lastPlayedAt) : "—"} />
      </dl>
      {(state.positionTicks ?? 0) > 0 && <ProgressBar value={percent / 100} label="Stored resume point" barClassName="bg-cyan-500" />}
    </div>
  );
}

function AccessResult({ result }: { result: ContentAccessResponse }) {
  return (
    <div className="min-w-0 flex-1 space-y-1 text-xs" role="status" aria-label="Age gate result">
      <div className="flex flex-wrap items-center gap-2">
        <ToneBadge tone={result.allowed ? "success" : "danger"}>{result.allowed ? "Allowed" : "Blocked"}</ToneBadge>
        <span>{accessReasonLabel(result.reason)}</span>
      </div>
      <p className="text-muted-foreground">
        Rating {result.rating ?? "—"} · minimum age {result.minimumAge ?? "—"} · viewer limit {result.viewerMaxAge ?? "none"}
        <span className="font-mono"> ({result.reason})</span>
      </p>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium tabular-nums">{value}</dd>
    </div>
  );
}
