import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Loader2,
  PlayCircle,
  Plus,
  Search as SearchIcon,
  ArrowDownUp,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { HealthBadge, ResolveOutcome } from "@/components/resolve-outcome";
import { useAllowIndexerDownloadHost, useDebugSearch, useResolve } from "@/api/queries";
import type {
  DebugReleaseDto,
  DebugWorkDto,
  ParsedFieldsDto,
  ScoreLineDto,
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
      await resolve.mutateAsync({ releaseId: release.releaseId!, client: "web" });
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
                      <Link to="/playback" search={{ releaseId: release.releaseId! }}>
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
