import { useId, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Film,
  ImageOff,
  Layers3,
  ListVideo,
  Loader2,
  PlayCircle,
  Plus,
  Search as SearchIcon,
  ArrowDownUp,
  Tv,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HealthBadge, ResolveOutcome } from "@/components/resolve-outcome";
import { PosterImage } from "@/components/poster-image";
import {
  useAllowIndexerDownloadHost,
  useDebugSearch,
  useGeneralConfig,
  useResolve,
  useSemanticSearch,
  useTvSeasonDetails,
  useTvSeriesDetails,
  useTvSeriesSearch,
} from "@/api/queries";
import type {
  DebugReleaseDto,
  DebugWorkDto,
  ParsedFieldsDto,
  ReleaseDto,
  ScoreLineDto,
  TvEpisodeDto,
  TvSeasonDto,
  TvSeriesDto,
  WorkDto,
} from "@/api/types";
import { ApiError, errorMessage } from "@/api/client";
import { cn, formatBytes } from "@/lib/utils";

interface Row {
  work: DebugWorkDto;
  release: DebugReleaseDto;
}

type SortKey = "score" | "size" | "age" | "grabs" | "name";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "score", label: "Score" },
  { key: "size", label: "Size" },
  { key: "age", label: "Age" },
  { key: "grabs", label: "Grabs" },
  { key: "name", label: "Name" },
];

export function SearchPage() {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Search</h2>
        <p className="text-sm text-muted-foreground">
          Discover available works by TMDB identity, or inspect the release pipeline in detail.
        </p>
      </div>

      <Tabs defaultValue="discovery">
        <TabsList
          aria-label="Search mode"
          className="grid h-auto w-full grid-cols-2 sm:inline-flex sm:h-9 sm:w-auto"
        >
          <TabsTrigger
            value="discovery"
            className="min-w-0 whitespace-normal px-2 leading-tight sm:px-3 sm:whitespace-nowrap"
          >
            Semantic discovery
          </TabsTrigger>
          <TabsTrigger
            value="diagnostics"
            className="min-w-0 whitespace-normal px-2 leading-tight sm:px-3 sm:whitespace-nowrap"
          >
            Release diagnostics
          </TabsTrigger>
        </TabsList>
        <TabsContent value="discovery" forceMount className="data-[state=inactive]:hidden">
          <SemanticDiscovery />
        </TabsContent>
        <TabsContent value="diagnostics" forceMount className="data-[state=inactive]:hidden">
          <DebugSearchPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SemanticDiscovery() {
  const movieSearch = useSemanticSearch();
  const seriesSearch = useTvSeriesSearch();
  const config = useGeneralConfig();
  const [query, setQuery] = useState("");
  const [type, setType] = useState<"any" | "movie" | "tv">("any");

  async function run(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) {
      toast.error("Enter a title, alias, or phrase to search.");
      return;
    }
    try {
      const requests: Promise<unknown>[] = [];
      if (type !== "tv") {
        // Explicitly constrain this branch so the legacy flat episode works never leak into
        // user-facing discovery. TV has its own series hierarchy below.
        requests.push(movieSearch.mutateAsync({ q, type: "movie" }));
      } else {
        movieSearch.reset();
      }
      if (type !== "movie") {
        requests.push(seriesSearch.mutateAsync({ q, limit: 3 }));
      } else {
        seriesSearch.reset();
      }
      await Promise.all(requests);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const movies = (movieSearch.data?.results ?? []).filter((work) => work.mediaType === "movie");
  const series = seriesSearch.data?.results ?? [];
  const pending = movieSearch.isPending || seriesSearch.isPending;
  const searched = movieSearch.isSuccess || seriesSearch.isSuccess;
  const searchError = movieSearch.error ?? seriesSearch.error;
  const tmdbMissing = config.isSuccess && !config.data.hasTmdbApiKey;

  return (
    <div className="space-y-5">
      {tmdbMissing && (
        <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="space-y-1">
            <p className="font-medium">TMDB metadata is not configured</p>
            <p className="text-muted-foreground">
              Semantic discovery deliberately hides unidentified indexer titles. Add a TMDB API
              key in <Link to="/settings" className="font-medium text-foreground underline underline-offset-4">Settings</Link>{" "}
              to enable canonical titles, covers, and media sections.
            </p>
          </div>
        </div>
      )}

      <Card className="overflow-hidden">
        <CardContent className="p-0">
          <div className="border-b bg-muted/30 px-5 py-4">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Availability-aware catalog
            </p>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Movies remain availability-filtered. TV search returns at most three canonical
              series; seasons and their episode availability load only when you open them.
            </p>
          </div>
          <form onSubmit={run} className="flex flex-col gap-3 p-5 sm:flex-row">
            <div className="relative flex-1">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label="Semantic query"
                placeholder="Try an alias, e.g. Dune 2"
                maxLength={256}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="pl-9"
                autoComplete="off"
              />
            </div>
            <select
              aria-label="Semantic media type"
              value={type}
              onChange={(event) => setType(event.target.value as typeof type)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="any">Movies &amp; TV</option>
              <option value="movie">Movies</option>
              <option value="tv">TV</option>
            </select>
            <Button type="submit" disabled={pending} className="sm:min-w-28">
              {pending ? <Loader2 className="size-4 animate-spin" /> : <SearchIcon className="size-4" />}
              Discover
            </Button>
          </form>
        </CardContent>
      </Card>

      {searchError && (
        <Card>
          <CardContent className="flex items-center gap-2 pt-6 text-sm text-destructive">
            <AlertTriangle className="size-4" />
            {errorMessage(searchError)}
          </CardContent>
        </Card>
      )}

      {searched && !pending && !searchError && movies.length === 0 && series.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <ImageOff className="size-7 text-muted-foreground" />
            <p className="font-medium">No semantic matches</p>
            <p className="max-w-lg text-sm text-muted-foreground">
              No movie with an accepted release or TV series candidate matched. Check metadata
              configuration, try another title, or inspect Release diagnostics for raw hits.
            </p>
          </CardContent>
        </Card>
      )}

      {pending && (
        <Card>
          <CardContent className="flex items-center justify-center gap-3 py-12 text-sm text-muted-foreground">
            <Loader2 className="size-5 animate-spin" /> Finding canonical works…
          </CardContent>
        </Card>
      )}

      {movies.length > 0 && (
        <DiscoverySection title="Movies" icon={Film} works={movies} />
      )}
      {series.length > 0 && (
        <TvSeriesSection series={series} />
      )}
    </div>
  );
}

function DiscoverySection({
  title,
  icon: Icon,
  works,
}: {
  title: string;
  icon: typeof Film;
  works: WorkDto[];
}) {
  const headingId = `semantic-${title.toLowerCase()}`;
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-muted-foreground" />
        <h3 id={headingId} className="font-semibold">{title}</h3>
        <Badge variant="secondary">{works.length}</Badge>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {works.map((work) => (
          <MovieDiscoveryCard key={work.workId ?? `${work.mediaType}-${work.tmdbId}`} work={work} />
        ))}
      </div>
    </section>
  );
}

function MovieDiscoveryCard({ work }: { work: WorkDto }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const releases = work.releases ?? [];
  const top = releases[0];
  const title = work.title ?? "Untitled";

  return (
    <Card
      className={cn(
        "group overflow-hidden border-border/80 transition-[border-color,box-shadow] duration-200",
        "hover:border-foreground/25 hover:shadow-md",
        open && "md:col-span-2 xl:col-span-3 border-foreground/20 shadow-md",
      )}
    >
      <div className="relative">
        <div className="grid min-h-56 grid-cols-[8rem_1fr]">
          <div className="relative overflow-hidden bg-muted">
            <PosterImage
              src={work.posterUrl}
              alt={`${title} poster`}
              className="h-full min-h-56 w-full object-cover transition-transform duration-300 group-hover:scale-[1.025]"
            />
            <Badge className="absolute bottom-2 left-2 bg-background/90 text-foreground shadow-sm">
              {releases.length} {releases.length === 1 ? "release" : "releases"}
            </Badge>
          </div>
          <div className="flex min-w-0 flex-col p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h4 className="font-semibold leading-tight">{title}</h4>
                <p className="mt-1 text-xs text-muted-foreground">
                  {[work.year, work.runtimeMinutes ? `${work.runtimeMinutes} min` : null]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
                TMDB {work.tmdbId}
              </Badge>
            </div>

            {work.overview && (
              <p className="mt-3 overflow-hidden text-xs leading-5 text-muted-foreground [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:3]">
                {work.overview}
              </p>
            )}

            <div className="mt-auto flex items-end justify-between gap-3 pt-4">
              {top && (
                <div className="flex flex-wrap gap-1.5">
                  {qualityParts(top).map((part) => (
                    <Badge key={part} variant="secondary" className="font-mono text-[10px]">{part}</Badge>
                  ))}
                </div>
              )}
              <span className="ml-auto flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground transition-colors group-hover:text-foreground">
                {open ? "Hide details" : "View details"}
                {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
              </span>
            </div>
          </div>
        </div>
        <button
          type="button"
          aria-label={`${title}, ${releases.length} ${releases.length === 1 ? "release" : "releases"}, ${open ? "collapse" : "expand"} details`}
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={() => setOpen((value) => !value)}
          className="absolute inset-0 z-10 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        />
      </div>

      {open && (
        <div id={detailsId} className="border-t bg-muted/15 px-4 py-5 sm:px-5">
          <div className="grid gap-5 xl:grid-cols-[minmax(14rem,0.7fr)_minmax(0,2fr)]">
            <div className="space-y-4">
              <div>
                <h5 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  About this work
                </h5>
                <p className="mt-2 text-sm leading-6 text-foreground/85">
                  {work.overview || "No synopsis is available from TMDB."}
                </p>
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
                <DiscoveryFact label="Media" value="Movie" />
                <DiscoveryFact label="Year" value={work.year?.toString()} />
                <DiscoveryFact label="Runtime" value={work.runtimeMinutes ? `${work.runtimeMinutes} min` : undefined} />
                <DiscoveryFact label="TMDB" value={work.tmdbId?.toString()} mono />
                <DiscoveryFact label="IMDb" value={work.imdbId ?? undefined} mono />
              </dl>
            </div>

            <div>
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div>
                  <h5 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    Available releases
                  </h5>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Ranked best first. Choose a release to resolve and play in the preview player.
                  </p>
                </div>
                <Badge variant="secondary">{releases.length} available</Badge>
              </div>
              <div className="mt-3 space-y-2">
                {releases.map((release, index) => (
                  <DiscoveryRelease
                    key={release.releaseId ?? `${release.title}-${index}`}
                    release={release}
                    rank={index + 1}
                    workId={work.workId ?? undefined}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

function TvSeriesSection({ series }: { series: TvSeriesDto[] }) {
  return (
    <section aria-labelledby="semantic-tv-series" className="space-y-3">
      <div className="flex items-center gap-2">
        <Tv className="size-4 text-muted-foreground" />
        <h3 id="semantic-tv-series" className="font-semibold">TV series</h3>
        <Badge variant="secondary">{series.length}</Badge>
        <span className="ml-auto hidden text-xs text-muted-foreground sm:inline">
          Top TMDB matches · availability loads by season
        </span>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {series.map((item) => (
          <TvSeriesCard key={item.workId ?? `series-${item.tmdbId}`} series={item} />
        ))}
      </div>
    </section>
  );
}

function TvSeriesCard({ series }: { series: TvSeriesDto }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const tmdbId = series.tmdbId ?? 0;
  const details = useTvSeriesDetails(tmdbId, open);
  const seriesDetails = details.data;
  const resolved = details.data?.series ?? series;
  const seasons = details.data?.seasons ?? [];
  const title = resolved.title ?? "Untitled series";

  return (
    <Card
      className={cn(
        "group overflow-hidden border-border/80 transition-[border-color,box-shadow] duration-200",
        "hover:border-foreground/25 hover:shadow-md",
        open && "md:col-span-2 xl:col-span-3 border-foreground/20 shadow-md",
      )}
    >
      <div className="relative">
        <div className="grid min-h-56 grid-cols-[8rem_1fr]">
          <div className="relative overflow-hidden bg-muted">
            <PosterImage
              src={resolved.posterUrl}
              alt={`${title} poster`}
              className="h-full min-h-56 w-full object-cover transition-transform duration-300 group-hover:scale-[1.025]"
            />
            <Badge className="absolute bottom-2 left-2 bg-background/90 text-foreground shadow-sm">
              Series
            </Badge>
          </div>
          <div className="flex min-w-0 flex-col p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h4 className="font-semibold leading-tight">{title}</h4>
                <p className="mt-1 text-xs text-muted-foreground">
                  {[resolved.year, resolved.runtimeMinutes ? `${resolved.runtimeMinutes} min episodes` : null]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
                TMDB {resolved.tmdbId}
              </Badge>
            </div>

            {resolved.overview && (
              <p className="mt-3 overflow-hidden text-xs leading-5 text-muted-foreground [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:3]">
                {resolved.overview}
              </p>
            )}

            <div className="mt-auto flex items-end justify-between gap-3 pt-4">
              <div className="flex flex-wrap gap-1.5">
                {resolved.seasonCount != null && (
                  <Badge variant="secondary">{resolved.seasonCount} seasons</Badge>
                )}
                {resolved.episodeCount != null && (
                  <Badge variant="secondary">{resolved.episodeCount} episodes</Badge>
                )}
              </div>
              <span className="ml-auto flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground transition-colors group-hover:text-foreground">
                {open ? "Hide seasons" : "Browse seasons"}
                {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
              </span>
            </div>
          </div>
        </div>
        <button
          type="button"
          aria-label={`${title}, ${open ? "collapse" : "browse"} seasons`}
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={() => setOpen((value) => !value)}
          className="absolute inset-0 z-10 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        />
      </div>

      {open && (
        <div id={detailsId} className="border-t bg-muted/15 px-4 py-5 sm:px-5">
          {details.isPending && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading the TMDB season directory…
            </p>
          )}
          {details.isError && (
            <p className="flex items-center gap-2 text-sm text-destructive">
              <AlertTriangle className="size-4" /> {errorMessage(details.error)}
            </p>
          )}
          {seriesDetails && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div>
                  <h5 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    <Layers3 className="size-4" /> Seasons
                  </h5>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Opening a season runs one cached indexer search and maps all results to its episodes.
                  </p>
                </div>
                <Badge variant="secondary">{seasons.length} directories</Badge>
              </div>
              <div className="space-y-2">
                {seasons.map((season) => (
                  <TvSeasonRow key={season.workId ?? season.seasonNumber} series={resolved} season={season} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function TvSeasonRow({ series, season }: { series: TvSeriesDto; season: TvSeasonDto }) {
  const [open, setOpen] = useState(false);
  const tmdbId = series.tmdbId ?? 0;
  const seasonNumber = season.seasonNumber ?? 0;
  const details = useTvSeasonDetails(tmdbId, seasonNumber, open);
  const seasonDetails = details.data;
  const episodes = seasonDetails?.episodes ?? [];
  const available = episodes.filter((episode) => (episode.releases?.length ?? 0) > 0).length;
  const label = seasonNumber === 0 ? "Specials" : (season.title ?? `Season ${seasonNumber}`);

  return (
    <article className="overflow-hidden rounded-md border bg-background/80 shadow-sm">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${label}, ${season.episodeCount ?? 0} episodes, ${open ? "collapse" : "load availability"}`}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted font-mono text-xs font-semibold">
          {seasonNumber === 0 ? "SP" : `S${String(seasonNumber).padStart(2, "0")}`}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{label}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {season.episodeCount ?? 0} episodes{season.airDate ? ` · ${season.airDate}` : ""}
          </span>
        </span>
        {seasonDetails && <Badge variant="secondary">{available} available</Badge>}
        {details.isPending ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
        ) : open ? (
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        )}
      </button>

      {open && (
        <div className="border-t bg-muted/10 p-3">
          {details.isPending && (
            <p className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Searching this season across configured indexers…
            </p>
          )}
          {details.isError && (
            <p className="flex items-center gap-2 py-3 text-sm text-destructive">
              <AlertTriangle className="size-4" /> {errorMessage(details.error)}
            </p>
          )}
          {seasonDetails && (
            <div className="space-y-3">
              {(seasonDetails.indexers ?? []).length > 0 && (
                <div className="flex flex-wrap gap-1.5" aria-label={`${label} indexer diagnostics`}>
                  {(seasonDetails.indexers ?? []).map((indexer) => (
                    <Badge
                      key={indexer.indexerId}
                      variant={indexer.status === "succeeded" ? "success" : "destructive"}
                      title={indexer.error ?? undefined}
                    >
                      {indexer.indexerName}: {indexer.itemCount ?? 0} · {Math.round(indexer.elapsedMs ?? 0)}ms
                    </Badge>
                  ))}
                </div>
              )}
              <div className="space-y-2">
                {episodes.map((episode) => (
                  <TvEpisodeRow key={episode.workId ?? episode.episodeNumber} episode={episode} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function TvEpisodeRow({ episode }: { episode: TvEpisodeDto }) {
  const [open, setOpen] = useState(false);
  const releases = episode.releases ?? [];
  const coordinate = `S${String(episode.seasonNumber ?? 0).padStart(2, "0")}E${String(episode.episodeNumber ?? 0).padStart(2, "0")}`;
  const canOpen = releases.length > 0;

  return (
    <article className="overflow-hidden rounded-md border bg-background">
      <button
        type="button"
        disabled={!canOpen}
        aria-expanded={canOpen ? open : undefined}
        aria-label={`${coordinate} ${episode.title ?? "Episode"}, ${releases.length} releases${canOpen ? `, ${open ? "collapse" : "expand"}` : ""}`}
        onClick={() => canOpen && setOpen((value) => !value)}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left enabled:transition-colors enabled:hover:bg-muted/35 disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ListVideo className="size-4 shrink-0 text-muted-foreground" />
        <span className="w-14 shrink-0 font-mono text-xs font-semibold">{coordinate}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{episode.title || `Episode ${episode.episodeNumber}`}</span>
          <span className="mt-0.5 block text-[11px] text-muted-foreground">
            {[episode.airDate, episode.runtimeMinutes ? `${episode.runtimeMinutes} min` : null]
              .filter(Boolean)
              .join(" · ") || "Metadata pending"}
          </span>
        </span>
        <Badge variant={releases.length > 0 ? "success" : "muted"}>
          {releases.length > 0 ? `${releases.length} available` : "not found"}
        </Badge>
        {canOpen && (open
          ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />)}
      </button>

      {open && (
        <div className="space-y-2 border-t bg-muted/10 p-3">
          {releases.map((release, index) => (
            <DiscoveryRelease
              key={release.releaseId ?? `${release.title}-${index}`}
              release={release}
              rank={index + 1}
              workId={episode.workId ?? undefined}
            />
          ))}
        </div>
      )}
    </article>
  );
}

function DiscoveryFact({
  label,
  value,
  mono = false,
}: {
  label: string;
  value?: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("mt-0.5 font-medium", mono && "font-mono")}>{value || "—"}</dd>
    </div>
  );
}

function DiscoveryRelease({
  release,
  rank,
  workId,
}: {
  release: ReleaseDto;
  rank: number;
  workId?: string;
}) {
  const facts = [
    release.indexer,
    formatBytes(release.sizeBytes),
    release.ageDays != null ? `${release.ageDays}d old` : null,
    release.grabs != null ? `${release.grabs} grabs` : null,
    `score ${release.score ?? 0}`,
  ].filter(Boolean);

  return (
    <article className="rounded-md border bg-background/80 p-3 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 gap-3">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full border bg-muted font-mono text-[10px] font-semibold text-muted-foreground">
            {rank}
          </span>
          <div className="min-w-0">
            <p className="break-words font-mono text-xs leading-5" title={release.title ?? ""}>
              {release.title || "Untitled release"}
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">{facts.join(" · ")}</p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {qualityParts(release).map((part) => (
                <Badge key={part} variant="outline" className="font-mono text-[10px]">{part}</Badge>
              ))}
              {(release.languages ?? []).map((language) => (
                <Badge key={language} variant="muted" className="font-mono text-[10px]">{language}</Badge>
              ))}
              <HealthBadge status={release.health} />
            </div>
          </div>
        </div>
        {release.releaseId ? (
          <Button asChild size="sm" className="shrink-0">
            <Link to="/playback" search={{ releaseId: release.releaseId, workId }}>
              <PlayCircle className="size-4" />
              Play preview
            </Link>
          </Button>
        ) : (
          <Button size="sm" disabled className="shrink-0">
            Release unavailable
          </Button>
        )}
      </div>
    </article>
  );
}

function qualityParts(release: ReleaseDto): string[] {
  return [
    release.quality?.resolution,
    release.quality?.source,
    release.quality?.codec,
    release.quality?.hdr,
  ].filter((part): part is string => Boolean(part));
}

function DebugSearchPanel() {
  const debug = useDebugSearch();
  const [form, setForm] = useState({ q: "", type: "any", season: "", episode: "", imdbId: "", tmdbId: "" });
  const [filter, setFilter] = useState("");
  const [showRejected, setShowRejected] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (!form.q.trim()) {
      toast.error("Enter a query to search.");
      return;
    }
    try {
      await debug.mutateAsync({
        q: form.q.trim(),
        type: form.type === "any" ? undefined : form.type,
        season: form.season ? Number(form.season) : undefined,
        episode: form.episode ? Number(form.episode) : undefined,
        imdbId: form.imdbId.trim() || undefined,
        tmdbId: form.tmdbId ? Number(form.tmdbId) : undefined,
      });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const results = debug.data?.results ?? [];
  const indexers = debug.data?.indexers ?? [];

  const rows = useMemo<Row[]>(() => {
    const flat: Row[] = [];
    for (const work of results) for (const release of work.releases ?? []) flat.push({ work, release });

    const term = filter.trim().toLowerCase();
    const filtered = flat.filter(({ release }) => {
      if (!showRejected && release.rejected) return false;
      if (!term) return true;
      return (release.title ?? "").toLowerCase().includes(term);
    });

    const dir = sortDir === "asc" ? 1 : -1;
    return filtered.sort((a, b) => {
      const ra = a.release;
      const rb = b.release;
      switch (sortKey) {
        case "name":
          return dir * (ra.title ?? "").localeCompare(rb.title ?? "");
        case "size":
          return dir * ((ra.sizeBytes ?? 0) - (rb.sizeBytes ?? 0));
        case "age":
          return dir * ((ra.ageDays ?? 0) - (rb.ageDays ?? 0));
        case "grabs":
          return dir * ((ra.grabs ?? 0) - (rb.grabs ?? 0));
        default:
          return dir * ((ra.score ?? 0) - (rb.score ?? 0));
      }
    });
  }, [results, filter, showRejected, sortKey, sortDir]);

  const total = results.reduce((n, w) => n + (w.releases?.length ?? 0), 0);
  const rejected = results.reduce((n, w) => n + (w.releases ?? []).filter((r) => r.rejected).length, 0);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Search / Debug playground</h2>
        <p className="text-sm text-muted-foreground">
          Every release from <code>/debug/search</code> — including rejected ones — with parsed
          fields, a per-rule score breakdown, and rejection reasons in plain language (BRIEF §9.1).
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={run} className="space-y-4">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                aria-label="Query"
                placeholder="e.g. Dune Part Two 2024"
                maxLength={256}
                value={form.q}
                onChange={set("q")}
                className="flex-1"
              />
              <select
                aria-label="Media type"
                value={form.type}
                onChange={set("type")}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="any">Any</option>
                <option value="movie">Movie</option>
                <option value="tv">TV</option>
              </select>
              <Button type="submit" disabled={debug.isPending}>
                {debug.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <SearchIcon className="size-4" />
                )}
                Search
              </Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-4">
              <Adv label="Season" value={form.season} onChange={set("season")} type="number" placeholder="1" />
              <Adv label="Episode" value={form.episode} onChange={set("episode")} type="number" placeholder="2" />
              <Adv label="IMDb ID" value={form.imdbId} onChange={set("imdbId")} maxLength={32} placeholder="tt1234567" />
              <Adv label="TMDB ID" value={form.tmdbId} onChange={set("tmdbId")} type="number" placeholder="12345" />
            </div>
          </form>
        </CardContent>
      </Card>

      {debug.isError && (
        <Card>
          <CardContent className="flex items-center gap-2 pt-6 text-sm text-destructive">
            <AlertTriangle className="size-4" />
            {errorMessage(debug.error)}
          </CardContent>
        </Card>
      )}

      {indexers.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs" aria-label="Indexer diagnostics">
          {indexers.map((ix) => (
            <Badge
              key={ix.indexerId}
              variant={ix.status === "succeeded" ? "success" : "destructive"}
              title={ix.error ?? undefined}
            >
              {ix.indexerName}: {ix.itemCount ?? 0} · {Math.round(ix.elapsedMs ?? 0)}ms
            </Badge>
          ))}
        </div>
      )}

      {debug.isSuccess && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Input
              aria-label="Filter releases"
              placeholder="Filter by name…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="max-w-xs"
            />
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={showRejected}
                onChange={(e) => setShowRejected(e.target.checked)}
                className="size-4 rounded border-input"
              />
              Show rejected
            </label>
            <div className="flex w-full flex-wrap items-center gap-1 sm:w-auto">
              <ArrowDownUp className="size-4 text-muted-foreground" />
              {SORTS.map((s) => (
                <Button
                  key={s.key}
                  type="button"
                  size="sm"
                  variant={sortKey === s.key ? "secondary" : "ghost"}
                  onClick={() => {
                    if (sortKey === s.key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
                    else {
                      setSortKey(s.key);
                      setSortDir("desc");
                    }
                  }}
                >
                  {s.label}
                  {sortKey === s.key && (sortDir === "asc" ? " ↑" : " ↓")}
                </Button>
              ))}
            </div>
            <span className="w-full text-sm text-muted-foreground sm:ml-auto sm:w-auto">
              {rows.length} shown · {total} releases · {rejected} rejected
            </span>
          </div>

          {rows.length === 0 ? (
            <Card>
              <CardContent className="pt-6 text-sm text-muted-foreground">
                No releases match. Check that indexers are configured and reachable, or widen the
                filter.
              </CardContent>
            </Card>
          ) : (
            <div
              className="overflow-x-auto rounded-lg border"
              role="region"
              aria-label="Search results"
              tabIndex={0}
            >
              <table className="min-w-[50rem] w-full text-sm">
                <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="sticky left-0 bg-muted px-2 py-2">
                      <span className="sr-only">Actions</span>
                    </th>
                    <th className="w-8" />
                    <th className="px-2 py-2 text-left font-medium">Release</th>
                    <th className="px-2 py-2 text-left font-medium">Indexer</th>
                    <th className="px-2 py-2 text-right font-medium">Size</th>
                    <th className="px-2 py-2 text-right font-medium">Age</th>
                    <th className="px-2 py-2 text-right font-medium">Grabs</th>
                    <th className="px-2 py-2 text-right font-medium">Score</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ work, release }) => (
                    <ReleaseRow key={release.releaseId} work={work} release={release} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Adv({
  label,
  ...props
}: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input {...props} />
    </div>
  );
}

function ReleaseRow({ work, release }: { work: DebugWorkDto; release: DebugReleaseDto }) {
  const [open, setOpen] = useState(false);
  const resolve = useResolve();
  const allowHost = useAllowIndexerDownloadHost();

  // The server rejects a download whose host isn't the indexer's origin with a structured
  // nzb_host_not_allowed error carrying the offending host + indexer, so we can offer a
  // one-click fix (BRIEF §6.3) instead of sending the operator to the indexer settings.
  const hostBlock =
    resolve.error instanceof ApiError && resolve.error.code === "nzb_host_not_allowed"
      ? resolve.error.envelope?.error
      : undefined;

  async function doResolve() {
    setOpen(true);
    try {
      await resolve.mutateAsync({
        releaseId: release.releaseId!,
        workId: work.workId,
        client: "web",
      });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function addHostAndRetry() {
    if (!hostBlock?.host || !hostBlock.indexerId) return;
    try {
      await allowHost.mutateAsync({ indexerId: hostBlock.indexerId, host: hostBlock.host });
      toast.success(`Added ${hostBlock.host} to ${release.indexer}'s allowed download hosts.`);
      await doResolve();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <>
      <tr
        className={cn(
          "border-t transition-colors hover:bg-muted/40",
          release.rejected && "opacity-60",
        )}
      >
        <td className="sticky left-0 bg-card px-2 py-2 text-right shadow-[8px_0_12px_-12px_hsl(var(--foreground))]">
          <Button size="sm" variant="outline" onClick={doResolve} disabled={resolve.isPending}>
            {resolve.isPending ? <Loader2 className="size-4 animate-spin" /> : "Resolve"}
          </Button>
        </td>
        <td className="pl-2">
          <button
            type="button"
            aria-label={open ? "Collapse" : "Expand"}
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className="flex size-6 items-center justify-center rounded hover:bg-accent"
          >
            {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </button>
        </td>
        <td className="px-2 py-2">
          <div className="flex flex-col gap-0.5">
            <span className="truncate font-mono text-xs" title={release.title ?? ""}>
              {release.title}
            </span>
            <span className="text-xs text-muted-foreground">
              {work.title}
              {work.year ? ` (${work.year})` : ""} · {qualitySummary(release.parsed)}
            </span>
          </div>
        </td>
        <td className="px-2 py-2 text-muted-foreground">{release.indexer}</td>
        <td className="px-2 py-2 text-right tabular-nums">{formatBytes(release.sizeBytes)}</td>
        <td className="px-2 py-2 text-right tabular-nums">{release.ageDays ?? "—"}d</td>
        <td className="px-2 py-2 text-right tabular-nums">{release.grabs ?? 0}</td>
        <td className="px-2 py-2 text-right">
          {release.rejected ? (
            <Badge variant="destructive">rejected</Badge>
          ) : (
            <span className="font-mono tabular-nums">{release.score}</span>
          )}
        </td>
      </tr>
      {open && (
        <tr className="border-t bg-muted/20">
          <td />
          <td colSpan={7} className="px-2 py-3">
            <div className="grid gap-4 lg:grid-cols-2">
              <ParsedFields parsed={release.parsed} />
              <div className="space-y-4">
                <ScoreBreakdown lines={release.scoreBreakdown} total={release.score} />
                <Rejections release={release} />
              </div>
            </div>
            <div className="mt-4">
              {resolve.isPending && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> Resolving — fetching NZB, health-checking
                  segments, probing media…
                </p>
              )}
              {resolve.isError && (
                <div className="space-y-2">
                  <p className="text-sm text-destructive">{errorMessage(resolve.error)}</p>
                  {hostBlock?.host && hostBlock.indexerId && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={addHostAndRetry}
                      disabled={allowHost.isPending || resolve.isPending}
                    >
                      {allowHost.isPending ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Plus className="size-4" />
                      )}
                      Allow “{hostBlock.host}” &amp; retry
                    </Button>
                  )}
                </div>
              )}
              {resolve.isSuccess && resolve.data && (
                <div className="space-y-3 rounded-md border p-3">
                  <ResolveOutcome resolve={resolve.data} />
                  {resolve.data.streamUrl && (
                    <Button asChild size="sm">
                      <Link
                        to="/playback"
                        search={{
                          releaseId: release.releaseId!,
                          workId: work.workId ?? undefined,
                        }}
                      >
                        <PlayCircle className="size-4" />
                        Play preview
                      </Link>
                    </Button>
                  )}
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function qualitySummary(p?: ParsedFieldsDto): string {
  if (!p) return "unparsed";
  return [p.resolution, p.source, p.videoCodec, p.hdr, p.audioCodec].filter(Boolean).join(" · ") || "unparsed";
}

function ParsedFields({ parsed }: { parsed?: ParsedFieldsDto }) {
  if (!parsed) return <p className="text-xs text-muted-foreground">No parsed fields.</p>;
  const entries: [string, string | undefined | null][] = [
    ["Title", parsed.title],
    ["Year", parsed.year?.toString()],
    ["Type", parsed.mediaType],
    ["Resolution", parsed.resolution],
    ["Source", parsed.source],
    ["Video codec", parsed.videoCodec],
    ["HDR", parsed.hdr],
    ["Audio", [parsed.audioCodec, parsed.audioChannels].filter(Boolean).join(" ")],
    ["Atmos", parsed.atmos ? "yes" : undefined],
    ["Edition", parsed.edition],
    ["Group", parsed.releaseGroup],
    ["Languages", parsed.languages?.join(", ")],
    ["Season", parsed.season?.toString()],
    ["Episodes", parsed.episodes?.join(", ")],
    ["Abs. episodes", parsed.absoluteEpisodes?.join(", ")],
    ["Season pack", parsed.seasonPack ? "yes" : undefined],
    ["PROPER", parsed.proper ? "yes" : undefined],
    ["REPACK", parsed.repack ? "yes" : undefined],
    ["Air date", parsed.airDate],
  ];
  const shown = entries.filter(([, v]) => v);
  return (
    <div>
      <h4 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Parsed fields</h4>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
        {shown.map(([k, v]) => (
          <div key={k} className="flex flex-col">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="font-medium">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function ScoreBreakdown({ lines, total }: { lines?: ScoreLineDto[] | null; total?: number }) {
  if (!lines || lines.length === 0)
    return <p className="text-xs text-muted-foreground">No score breakdown (release was rejected before ranking).</p>;
  return (
    <div>
      <h4 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Score breakdown</h4>
      <ul className="space-y-0.5 text-xs">
        {lines.map((l, i) => (
          <li key={i} className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">{l.rule}</span>
            <span className={cn("font-mono tabular-nums", (l.points ?? 0) < 0 && "text-destructive")}>
              {(l.points ?? 0) > 0 ? "+" : ""}
              {l.points}
            </span>
          </li>
        ))}
        <li className="mt-1 flex items-center justify-between gap-2 border-t pt-1 font-medium">
          <span>Total</span>
          <span className="font-mono tabular-nums">{total}</span>
        </li>
      </ul>
    </div>
  );
}

function Rejections({ release }: { release: DebugReleaseDto }) {
  return (
    <div>
      <h4 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
        Status <HealthBadge status={release.health} />
      </h4>
      {release.rejected ? (
        <ul className="space-y-1 text-xs">
          {(release.rejections ?? []).map((r, i) => (
            <li key={i} className="flex items-start gap-2 text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>
                <span className="font-medium">{r.message}</span>{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-muted-foreground">{r.code}</code>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">Accepted — not rejected by any rule.</p>
      )}
    </div>
  );
}
