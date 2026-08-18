import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  Activity,
  AlertTriangle,
  Check,
  Circle,
  CircleDashed,
  Clock3,
  Copy,
  Database,
  Download,
  Gauge,
  Radio,
  Server,
  Timer,
  XCircle,
  Zap,
} from "lucide-react";
import type {
  ArticleMapResponse,
  ArticleProviderAttemptResponse,
  ArticleProviderSummaryResponse,
  ArticleTelemetryResponse,
} from "@/api/types";
import { cn, formatBytes, formatMs } from "@/lib/utils";

type ArticleFilter = "all" | "active" | "failed" | "slow";
type NormalizedArticle = ArticleTelemetryResponse & { index: number };

interface ArticleCell {
  articles: NormalizedArticle[];
  representative: NormalizedArticle;
}

const ACTIVE_STATES = new Set(["queued", "downloading"]);
const MAX_ARTICLE_CELLS = 2_500;
const STATE_PRIORITY: Record<string, number> = {
  failed: 0,
  downloading: 1,
  queued: 2,
  partial: 3,
  cached: 4,
  downloaded: 4,
  pending: 5,
};

const STATE_META: Record<string, { label: string; cell: string; text: string }> = {
  pending: {
    label: "Pending",
    cell: "border-muted-foreground/20 bg-muted-foreground/10",
    text: "text-muted-foreground",
  },
  queued: {
    label: "Queued",
    cell: "border-slate-400/60 bg-slate-400/60 dark:border-slate-500 dark:bg-slate-500/60",
    text: "text-slate-950 dark:text-slate-100",
  },
  downloading: {
    label: "Downloading",
    cell: "border-cyan-400 bg-cyan-500 shadow-[0_0_12px_-2px_rgba(6,182,212,.9)]",
    text: "text-cyan-950",
  },
  downloaded: {
    label: "Downloaded",
    cell: "border-primary/60 bg-primary",
    text: "text-primary-foreground",
  },
  cached: {
    label: "Cached",
    cell: "border-emerald-500/70 bg-emerald-500",
    text: "text-emerald-950",
  },
  failed: {
    label: "Failed",
    cell: "border-rose-600 bg-rose-500 shadow-[0_0_12px_-3px_rgba(244,63,94,.8)]",
    text: "text-white",
  },
  partial: {
    label: "Partial",
    cell: "border-amber-500/80 bg-amber-400",
    text: "text-amber-950",
  },
};

const OUTCOME_META: Record<string, string> = {
  success: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  missing: "border-amber-500/25 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  error: "border-rose-500/25 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  rejected: "border-rose-500/25 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  cancelled: "border-muted-foreground/20 bg-muted/40 text-muted-foreground",
};

export interface ArticleMapProps {
  data: ArticleMapResponse;
  className?: string;
}

export function ArticleMap({ data, className }: ArticleMapProps) {
  const headingId = useId();
  const keyboardHelpId = useId();
  const articles = useMemo<NormalizedArticle[]>(
    () => (data.articles ?? [])
      .map((article, position) => ({ ...article, index: article.index ?? position }))
      .sort((a, b) => a.index - b.index),
    [data.articles],
  );
  const cells = useMemo(() => buildArticleCells(articles), [articles]);
  const slowThresholdMs = useMemo(() => calculateSlowThreshold(articles), [articles]);
  const [filter, setFilter] = useState<ArticleFilter>("all");
  const [selectedIndex, setSelectedIndex] = useState<number | null>(() =>
    preferredArticle(articles)?.index ?? null,
  );
  const cellRefs = useRef(new Map<number, HTMLButtonElement>());
  const selected = articles.find((article) => article.index === selectedIndex) ?? preferredArticle(articles);
  const selectedCellPosition = selected
    ? cells.findIndex((cell) => cell.articles.some((article) => article.index === selected.index))
    : -1;

  useEffect(() => {
    if (selectedIndex == null || !articles.some((article) => article.index === selectedIndex)) {
      setSelectedIndex(preferredArticle(articles)?.index ?? null);
    }
  }, [articles, selectedIndex]);

  const counts = useMemo(
    () => ({
      all: articles.length,
      active: articles.filter((article) => ACTIVE_STATES.has(normalize(article.state))).length,
      failed: articles.filter((article) => normalize(article.state) === "failed").length,
      slow: articles.filter((article) => isSlow(article, slowThresholdMs)).length,
    }),
    [articles, slowThresholdMs],
  );
  const total = Math.max(data.totalArticles ?? 0, articles.length);
  const tracked = Math.min(
    total,
    Math.max(articles.length, data.trackedArticles ?? articles.length),
  );
  const untracked = Math.max(0, total - tracked);
  const complete = Math.min(
    tracked,
    Math.max(0, (data.downloadedArticles ?? 0) + (data.cachedArticles ?? 0)),
  );
  const completePercent = total > 0 ? (complete / total) * 100 : 0;

  function changeFilter(nextFilter: ArticleFilter) {
    setFilter(nextFilter);
    if (nextFilter === "all") return;
    const match = articles.find((article) => matchesFilter(article, nextFilter, slowThresholdMs));
    if (!match) return;
    setSelectedIndex(match.index);
    const position = cells.findIndex((cell) =>
      cell.articles.some((article) => article.index === match.index));
    cellRefs.current.get(position)?.scrollIntoView?.({ block: "nearest" });
  }

  function selectFromKeyboard(event: KeyboardEvent<HTMLButtonElement>, position: number) {
    let next = position;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = Math.min(cells.length - 1, position + 1);
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = Math.max(0, position - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = cells.length - 1;
    else return;

    event.preventDefault();
    const cell = cells[next];
    if (!cell) return;
    setSelectedIndex(preferredArticleInCell(cell, filter, slowThresholdMs).index);
    cellRefs.current.get(next)?.focus();
  }

  return (
    <section
      className={cn(
        "relative isolate overflow-hidden border-y bg-card text-card-foreground",
        className,
      )}
      aria-labelledby={headingId}
    >
      <div
        className="pointer-events-none absolute inset-0 -z-10 opacity-45"
        style={{
          backgroundImage:
            "linear-gradient(hsl(var(--primary) / .045) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--primary) / .045) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
          maskImage: "linear-gradient(to bottom, black, transparent 68%)",
        }}
      />

      <div className="border-b px-4 py-6 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div className="max-w-2xl">
            <p className="flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-700 dark:text-cyan-300">
              <Radio className="size-3.5" /> Release transport / article flight map
            </p>
            <h3 id={headingId} className="mt-2 text-xl font-semibold tracking-[-0.025em] sm:text-2xl">
              Every article, one live signal
            </h3>
            <p className="mt-2 max-w-xl text-xs leading-5 text-muted-foreground">
              Ordered exactly like the release. Select a cell to inspect its NNTP route, timing,
              provider failover, and captured error evidence.
            </p>
          </div>
          <div className="min-w-0 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground xl:max-w-md xl:text-right">
            <p className="truncate" title={data.releaseId ?? undefined}>release / {data.releaseId || "unknown"}</p>
            <p className="mt-1">updated / {formatTimestamp(data.updatedAt)}</p>
          </div>
        </div>

        <div className="mt-6 grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2 xl:grid-cols-4">
          <SummaryMetric
            icon={<Database />}
            label="Articles complete"
            value={`${complete.toLocaleString()} / ${total.toLocaleString()}`}
            detail={untracked > 0
              ? `${formatPercent(completePercent)} confirmed · ${untracked.toLocaleString()} untracked`
              : `${formatPercent(completePercent)} release coverage`}
          />
          <SummaryMetric
            icon={<Activity />}
            label="On the wire"
            value={(data.activeArticles ?? 0).toLocaleString()}
            detail={`${(data.pendingArticles ?? 0).toLocaleString()} pending · ${(data.partialArticles ?? 0).toLocaleString()} partial`}
            tone="cyan"
          />
          <SummaryMetric
            icon={<Zap />}
            label="Effective rate"
            value={formatRate(data.effectiveBytesPerSecond)}
            detail={`${formatBytes(data.downloadedBytes)} complete · ${formatMs(data.averageDurationMs)} avg`}
          />
          <SummaryMetric
            icon={<AlertTriangle />}
            label="Failed articles"
            value={(data.failedArticles ?? 0).toLocaleString()}
            detail={data.failedArticles ? "open the red cells for evidence" : "no terminal failures"}
            tone={data.failedArticles ? "danger" : "default"}
          />
        </div>

        <CoverageRail
          data={data}
          total={total}
          tracked={tracked}
          untracked={untracked}
          complete={complete}
        />

        {untracked > 0 && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-900 dark:text-amber-200" role="note">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <p>
              Safety limit active: {tracked.toLocaleString()} of {total.toLocaleString()} articles carry per-article telemetry in this snapshot; {untracked.toLocaleString()} are not individually tracked.
            </p>
          </div>
        )}
      </div>

      {(data.providers?.length ?? 0) > 0 && (
        <ProviderStrip providers={data.providers ?? []} />
      )}

      <div className="grid min-w-0 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,25rem)]">
        <div className="min-w-0 p-4 sm:p-6 lg:p-8 xl:border-r">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">Ordered release surface</p>
              <p className="mt-1 text-sm font-medium">
                {filter === "all"
                  ? cells.length === articles.length
                    ? `${articles.length.toLocaleString()} articles visible`
                    : `${articles.length.toLocaleString()} articles represented in ${cells.length.toLocaleString()} ordered cells`
                  : `${counts[filter].toLocaleString()} ${filter === "active" ? "in flight" : filter} · all cells retained for context`}
              </p>
            </div>
            <div className="flex flex-wrap gap-1" role="group" aria-label="Filter article map">
              <FilterButton active={filter === "all"} onClick={() => changeFilter("all")}>All <span>{counts.all}</span></FilterButton>
              <FilterButton active={filter === "active"} onClick={() => changeFilter("active")}>In flight <span>{counts.active}</span></FilterButton>
              <FilterButton active={filter === "failed"} onClick={() => changeFilter("failed")}>Failed <span>{counts.failed}</span></FilterButton>
              <FilterButton active={filter === "slow"} onClick={() => changeFilter("slow")} title={`Slower than ${formatMs(slowThresholdMs)}`}>
                Slow <span>{counts.slow}</span>
              </FilterButton>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap gap-x-4 gap-y-2 font-mono text-[9px] uppercase tracking-wider text-muted-foreground" aria-label="Article state legend">
            {Object.entries(STATE_META).map(([state, meta]) => (
              <span key={state} className="flex items-center gap-1.5">
                <span className={cn("flex size-4 items-center justify-center rounded-[3px] border", meta.cell, meta.text)}>
                  <StateGlyph state={state} className="size-2.5" />
                </span>
                {meta.label}
              </span>
            ))}
          </div>

          <p id={keyboardHelpId} className="sr-only">
            Use the arrow keys to inspect adjacent articles. Home and End jump to the first and last article.
          </p>
          {articles.length > 0 ? (
            <ol
              className="mt-5 grid max-h-[30rem] content-start gap-1 overflow-y-auto rounded-xl border bg-muted/15 p-3 shadow-inner focus-within:border-primary/40"
              style={{ gridTemplateColumns: "repeat(auto-fill, minmax(1.5rem, 1fr))" }}
              aria-label="Articles in release order"
            >
              {cells.map((cell, position) => {
                const matches = cell.articles.some((candidate) => matchesFilter(candidate, filter, slowThresholdMs));
                const isSelected = selectedCellPosition === position;
                const article = isSelected && selected
                  ? selected
                  : filter !== "all" && matches
                  ? preferredArticleInCell(cell, filter, slowThresholdMs)
                  : cell.representative;
                const state = normalize(article.state);
                const meta = stateMeta(state);
                const containsDownloading = cell.articles.some((candidate) => normalize(candidate.state) === "downloading");
                const first = cell.articles[0];
                const last = cell.articles.at(-1) ?? first;
                return (
                  <li key={`${first.index}-${last.index}`} className="aspect-square min-w-0">
                    <button
                      ref={(node) => {
                        if (node) cellRefs.current.set(position, node);
                        else cellRefs.current.delete(position);
                      }}
                      type="button"
                      tabIndex={isSelected ? 0 : -1}
                      aria-label={articleCellLabel(cell, article)}
                      aria-describedby={keyboardHelpId}
                      aria-pressed={isSelected}
                      data-article-index={article.index}
                      data-article-start={first.index}
                      data-article-end={last.index}
                      data-article-state={state}
                      data-bin-size={cell.articles.length}
                      data-filter-match={matches ? "true" : "false"}
                      title={articleCellTitle(cell, article)}
                      onClick={() => setSelectedIndex(article.index)}
                      onKeyDown={(event) => selectFromKeyboard(event, position)}
                      className={cn(
                        "group relative block size-full overflow-hidden rounded-[3px] border transition-[opacity,transform,filter,box-shadow] duration-200 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                        meta.cell,
                        meta.text,
                        filter !== "all" && !matches && "scale-90 opacity-15 grayscale",
                        filter !== "all" && matches && "scale-105",
                        isSelected && "z-10 ring-2 ring-foreground ring-offset-1 ring-offset-card",
                      )}
                    >
                      {state === "downloading" && (
                        <span className="absolute inset-0 animate-ping rounded-[3px] bg-cyan-300/80 motion-reduce:animate-none" />
                      )}
                      <span className="absolute inset-0 z-[1] flex items-center justify-center" aria-hidden="true">
                        <StateGlyph state={state} className="size-2.5" />
                      </span>
                      {containsDownloading && state !== "downloading" && (
                        <span className="absolute bottom-px right-px z-[2] size-1 rounded-full bg-cyan-300 ring-1 ring-cyan-950/50" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ol>
          ) : (
            <div className="mt-5 flex min-h-40 items-center justify-center rounded-xl border border-dashed px-6 text-center font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              No article telemetry in this snapshot
            </div>
          )}
        </div>

        <aside className="min-w-0 border-t bg-muted/10 p-4 sm:p-6 lg:p-8 xl:border-t-0" aria-label="Selected article details">
          {selected ? (
            <ArticleInspector
              key={selected.index}
              article={selected}
              cell={selectedCellPosition >= 0 ? cells[selectedCellPosition] : undefined}
              onSelectArticle={setSelectedIndex}
            />
          ) : (
            <div className="flex min-h-64 flex-col items-center justify-center text-center text-muted-foreground">
              <CircleSignal />
              <p className="mt-4 text-sm">Select an article to inspect its provider route.</p>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}

function CoverageRail({
  data,
  total,
  tracked,
  untracked,
  complete,
}: {
  data: ArticleMapResponse;
  total: number;
  tracked: number;
  untracked: number;
  complete: number;
}) {
  let remainingTracked = Math.max(0, tracked - complete);
  const take = (value?: number | null) => {
    const count = Math.min(remainingTracked, Math.max(0, value ?? 0));
    remainingTracked -= count;
    return count;
  };
  const active = take(data.activeArticles);
  const partial = take(data.partialArticles);
  const failed = take(data.failedArticles);
  const pending = take(data.pendingArticles);
  const unknown = untracked + remainingTracked;
  const segments: Array<{ key: string; value: number; className: string; pattern?: string }> = [
    { key: "complete", value: complete, className: "bg-primary" },
    { key: "active", value: active, className: "bg-cyan-500" },
    { key: "partial", value: partial, className: "bg-amber-400" },
    { key: "failed", value: failed, className: "bg-rose-500" },
    { key: "pending", value: pending, className: "bg-muted-foreground/15" },
    {
      key: "untracked",
      value: unknown,
      className: "bg-muted/70",
      pattern: "repeating-linear-gradient(135deg, transparent 0 3px, hsl(var(--muted-foreground) / .32) 3px 5px)",
    },
  ];
  const now = total > 0 ? Math.round((complete / total) * 100) : 0;

  return (
    <div className="mt-4">
      <div
        className="flex h-2 overflow-hidden rounded-full border bg-muted/40"
        role="progressbar"
        aria-label="Article completion"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={now}
        aria-valuetext={`${complete.toLocaleString()} confirmed complete of ${total.toLocaleString()}; ${unknown.toLocaleString()} untracked or unknown`}
      >
        {segments.filter((segment) => segment.value > 0).map((segment) => (
          <span
            key={segment.key}
            data-coverage-segment={segment.key}
            className={segment.className}
            style={{
              width: `${total > 0 ? (segment.value / total) * 100 : 0}%`,
              backgroundImage: segment.pattern,
            }}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
        <span>{(data.cachedArticles ?? 0).toLocaleString()} cache resident</span>
        <span>{(data.downloadedArticles ?? 0).toLocaleString()} downloaded</span>
        {unknown > 0 && (
          <span className="ml-auto flex items-center gap-1.5">
            <span
              className="h-2 w-4 rounded-sm border bg-muted/70"
              style={{ backgroundImage: "repeating-linear-gradient(135deg, transparent 0 2px, hsl(var(--muted-foreground) / .38) 2px 4px)" }}
            />
            {unknown.toLocaleString()} untracked / unknown
          </span>
        )}
      </div>
    </div>
  );
}

function SummaryMetric({
  icon,
  label,
  value,
  detail,
  tone = "default",
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
  tone?: "default" | "cyan" | "danger";
}) {
  return (
    <div className="min-w-0 bg-card/95 p-4 sm:p-5">
      <div className={cn(
        "flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground [&_svg]:size-3.5",
        tone === "cyan" && "[&_svg]:text-cyan-600 dark:[&_svg]:text-cyan-400",
        tone === "danger" && "text-rose-700 dark:text-rose-300 [&_svg]:text-rose-500",
        tone === "default" && "[&_svg]:text-primary",
      )}>
        {icon}{label}
      </div>
      <p className={cn(
        "mt-2 truncate font-mono text-xl font-medium tabular-nums",
        tone === "danger" ? "text-rose-700 dark:text-rose-300" : "text-foreground",
      )}>{value}</p>
      <p className="mt-1 truncate text-[10px] text-muted-foreground/80" title={detail}>{detail}</p>
    </div>
  );
}

function ProviderStrip({ providers }: { providers: ArticleProviderSummaryResponse[] }) {
  return (
    <div className="border-b bg-muted/15 px-4 py-4 sm:px-6 lg:px-8">
      <div className="mb-3 flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
        <Server className="size-3.5 text-primary" /> Provider lanes
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4" role="list" aria-label="Provider outcomes">
        {providers.map((provider, index) => (
          <div key={`${provider.provider ?? "provider"}-${index}`} className="min-w-0 rounded-lg border bg-card/80 px-3 py-2.5" role="listitem">
            <div className="flex items-center justify-between gap-3">
              <p className="truncate font-mono text-[11px] font-medium" title={provider.provider ?? undefined}>{provider.provider || "Unknown provider"}</p>
              <span className="shrink-0 font-mono text-[9px] text-muted-foreground">{formatMs(provider.averageDurationMs)} avg</span>
            </div>
            <div className="mt-2 flex gap-3 font-mono text-[9px] uppercase tracking-wider">
              <span className="text-emerald-700 dark:text-emerald-300">{provider.successes ?? 0} ok</span>
              <span className="text-amber-800 dark:text-amber-300">{provider.missing ?? 0} missing</span>
              <span className="text-rose-700 dark:text-rose-300">{provider.errors ?? 0} errors</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FilterButton({ active, children, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { active: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 font-mono text-[9px] font-semibold uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "border-primary/30 bg-primary/10 text-primary"
          : "bg-background/60 text-muted-foreground hover:bg-muted hover:text-foreground",
        "[&_span]:rounded-full [&_span]:bg-muted [&_span]:px-1.5 [&_span]:py-0.5 [&_span]:tabular-nums",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

function ArticleInspector({
  article,
  cell,
  onSelectArticle,
}: {
  article: NormalizedArticle;
  cell?: ArticleCell;
  onSelectArticle: (index: number) => void;
}) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);
  const state = normalize(article.state);
  const meta = stateMeta(state);
  const attempts = article.attempts ?? [];

  useEffect(() => () => {
    if (resetTimer.current != null) window.clearTimeout(resetTimer.current);
  }, []);

  async function copyMessageId() {
    if (!article.messageId || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(article.messageId);
      setCopied(true);
      resetTimer.current = window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">Selected article</p>
          <h4 className="mt-1 text-lg font-semibold tracking-tight" aria-live="polite">Article {article.index + 1}</h4>
          {(article.fileName || article.articleNumber != null) && (
            <p className="mt-1 max-w-[15rem] truncate font-mono text-[9px] text-muted-foreground" title={article.fileName ?? undefined}>
              {article.fileName || "NZB file"}{article.articleNumber != null ? ` / part ${article.articleNumber}` : ""}
            </p>
          )}
        </div>
        <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-1 font-mono text-[9px] font-semibold uppercase tracking-wider", meta.cell, meta.text)}>
          <StateGlyph state={state} className="size-3" />{meta.label}
        </span>
      </div>

      {cell && cell.articles.length > 1 && (
        <label className="mt-4 block rounded-lg border bg-background/65 p-3">
          <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground">
            Exact article within grouped cell
          </span>
          <select
            value={article.index}
            onChange={(event) => onSelectArticle(Number(event.target.value))}
            className="mt-2 h-9 w-full rounded-md border bg-background px-2.5 font-mono text-[10px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {cell.articles.map((candidate) => (
              <option key={candidate.index} value={candidate.index}>
                #{candidate.index + 1} · {stateMeta(normalize(candidate.state)).label}
                {candidate.articleNumber != null ? ` · file part ${candidate.articleNumber}` : ""}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="mt-5 rounded-lg border bg-background/65 p-3">
        <div className="flex items-center justify-between gap-3">
          <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground">Exact message ID</p>
          <button
            type="button"
            onClick={copyMessageId}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={copied ? "Article message ID copied" : "Copy article message ID"}
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </button>
        </div>
        <code className="mt-2 block break-all font-mono text-[10px] leading-5 text-foreground">{article.messageId || "—"}</code>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border">
        <InspectorMetric icon={<Database />} label="Received / expected" value={formatPayload(article)} />
        <InspectorMetric icon={<Timer />} label="Duration" value={formatMs(article.durationMs)} />
        <InspectorMetric icon={<Gauge />} label="Throughput" value={formatRate(article.throughputBytesPerSecond)} />
        <InspectorMetric icon={<Server />} label="Last successful provider" value={article.successfulProvider || "—"} />
      </dl>

      {(article.startedAt || article.completedAt) && (
        <dl className="mt-4 divide-y border-y font-mono text-[10px]">
          <TimeRow label="Started" value={formatTimestamp(article.startedAt)} />
          <TimeRow label="Completed" value={formatTimestamp(article.completedAt)} />
        </dl>
      )}

      {(article.errorType || article.errorMessage) && (
        <div className="mt-4 rounded-lg border border-rose-500/25 bg-rose-500/10 p-3 text-rose-800 dark:text-rose-200" role="alert">
          <p className="flex items-center gap-2 font-mono text-[9px] font-semibold uppercase tracking-[0.16em]"><AlertTriangle className="size-3.5" />{article.errorType || "Article failure"}</p>
          {article.errorMessage && <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-5">{article.errorMessage}</p>}
        </div>
      )}

      <div className="mt-6 flex items-center justify-between gap-3">
        <div>
          <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">Provider attempts</p>
          <p className="mt-1 text-sm font-medium">The route this article took</p>
        </div>
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{article.providerAttemptCount ?? attempts.length}</span>
      </div>

      {article.attemptsTruncated && (
        <p className="mt-2 rounded-md border border-amber-500/25 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-900 dark:text-amber-200" role="note">
          Showing the latest {attempts.length} of {(article.providerAttemptCount ?? attempts.length).toLocaleString()} provider attempts.
        </p>
      )}

      {attempts.length ? (
        <ol className="mt-3 space-y-2" aria-label={`Provider attempts for article ${article.index + 1}`}>
          {attempts.map((attempt: ArticleProviderAttemptResponse, index: number) => (
            <ProviderAttempt key={`${attempt.provider ?? "provider"}-${attempt.operation ?? "operation"}-${index}`} attempt={attempt} index={index} />
          ))}
        </ol>
      ) : (
        <div className="mt-3 rounded-lg border border-dashed px-4 py-6 text-center font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
          No provider attempt recorded yet
        </div>
      )}
    </div>
  );
}

function ProviderAttempt({ attempt, index }: { attempt: ArticleProviderAttemptResponse; index: number }) {
  const outcome = normalize(attempt.outcome);
  const outcomeClass = OUTCOME_META[outcome] ?? OUTCOME_META.cancelled;
  const hasError = attempt.errorType || attempt.errorMessage;
  return (
    <li className="relative overflow-hidden rounded-lg border bg-card px-3 py-3">
      <span className={cn(
        "absolute inset-y-0 left-0 w-0.5",
        outcome === "success" && "bg-emerald-500",
        outcome === "missing" && "bg-amber-500",
        (outcome === "error" || outcome === "rejected") && "bg-rose-500",
        outcome === "cancelled" && "bg-muted-foreground/30",
      )} />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] font-medium" title={attempt.provider ?? undefined}>
            <span className="mr-1.5 text-muted-foreground">{index + 1}.</span>{attempt.provider || "Unknown provider"}
          </p>
          <p className="mt-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
            {attempt.operation || "BODY"}{attempt.responseCode != null ? ` / ${attempt.responseCode}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className={cn("rounded-full border px-2 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-wider", outcomeClass)}>{outcome || "unknown"}</span>
          <span className="font-mono text-[9px] tabular-nums text-muted-foreground">{formatMs(attempt.durationMs)}</span>
        </div>
      </div>
      {hasError && (
        <div className="mt-2 border-t pt-2 text-[11px] leading-4 text-muted-foreground">
          {attempt.errorType && <p className="font-mono text-[9px] font-semibold uppercase tracking-wider text-rose-700 dark:text-rose-300">{attempt.errorType}</p>}
          {attempt.errorMessage && <p className="mt-1 whitespace-pre-wrap break-words">{attempt.errorMessage}</p>}
        </div>
      )}
    </li>
  );
}

function InspectorMetric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="min-w-0 bg-card p-3">
      <dt className="flex items-center gap-1.5 font-mono text-[8px] uppercase tracking-wider text-muted-foreground [&_svg]:size-3 [&_svg]:text-primary">{icon}{label}</dt>
      <dd className="mt-2 truncate font-mono text-[11px] text-foreground" title={value}>{value}</dd>
    </div>
  );
}

function TimeRow({ label, value }: { label: string; value: string }) {
  return <div className="flex items-center justify-between gap-4 py-2"><dt className="text-muted-foreground">{label}</dt><dd className="truncate text-right text-foreground">{value}</dd></div>;
}

function CircleSignal() {
  return (
    <span className="relative flex size-12 items-center justify-center rounded-full border bg-background text-primary">
      <span className="absolute size-7 rounded-full border border-primary/20" />
      <span className="size-2 rounded-full bg-primary" />
    </span>
  );
}

function preferredArticle(articles: NormalizedArticle[]) {
  return articles.find((article) => normalize(article.state) === "downloading")
    ?? articles.find((article) => normalize(article.state) === "queued")
    ?? articles.find((article) => normalize(article.state) === "failed")
    ?? articles[0];
}

function buildArticleCells(articles: NormalizedArticle[]): ArticleCell[] {
  if (articles.length <= MAX_ARTICLE_CELLS) {
    return articles.map((article) => ({ articles: [article], representative: article }));
  }

  return Array.from({ length: MAX_ARTICLE_CELLS }, (_, cellIndex) => {
    const start = Math.floor((cellIndex * articles.length) / MAX_ARTICLE_CELLS);
    const end = Math.floor(((cellIndex + 1) * articles.length) / MAX_ARTICLE_CELLS);
    const range = articles.slice(start, end);
    return { articles: range, representative: highestPriorityArticle(range) };
  });
}

function highestPriorityArticle(articles: NormalizedArticle[]) {
  return articles.reduce((best, candidate) =>
    statePriority(candidate.state) < statePriority(best.state) ? candidate : best,
  );
}

function preferredArticleInCell(
  cell: ArticleCell,
  filter: ArticleFilter,
  slowThresholdMs: number,
) {
  if (filter === "all") return cell.representative;
  const matching = cell.articles.filter((article) => matchesFilter(article, filter, slowThresholdMs));
  return matching.length > 0 ? highestPriorityArticle(matching) : cell.representative;
}

function statePriority(state?: string | null) {
  return STATE_PRIORITY[normalize(state)] ?? Number.MAX_SAFE_INTEGER;
}

function calculateSlowThreshold(articles: ArticleTelemetryResponse[]) {
  const durations = articles
    .filter((article) => normalize(article.state) === "downloaded")
    .map((article) => article.durationMs)
    .filter((duration): duration is number => duration != null && Number.isFinite(duration) && duration >= 0)
    .sort((a, b) => a - b);
  if (durations.length === 0) return 1_000;

  const baseline = median(durations);
  const deviations = durations
    .map((duration) => Math.abs(duration - baseline))
    .sort((a, b) => a - b);
  return Math.max(1_000, baseline + Math.max(500, median(deviations) * 3));
}

function median(values: number[]) {
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0
    ? (values[middle - 1] + values[middle]) / 2
    : values[middle];
}

function matchesFilter(article: ArticleTelemetryResponse, filter: ArticleFilter, slowThresholdMs: number) {
  const state = normalize(article.state);
  if (filter === "all") return true;
  if (filter === "active") return ACTIVE_STATES.has(state);
  if (filter === "failed") return state === "failed";
  return isSlow(article, slowThresholdMs);
}

function isSlow(article: ArticleTelemetryResponse, thresholdMs: number) {
  return article.durationMs != null && Number.isFinite(article.durationMs) && article.durationMs >= thresholdMs;
}

function articleLabel(article: NormalizedArticle) {
  const provider = article.successfulProvider ? `, provider ${article.successfulProvider}` : "";
  return `Article ${article.index + 1}: ${stateMeta(normalize(article.state)).label}${provider}`;
}

function articleCellLabel(cell: ArticleCell, representative = cell.representative) {
  if (cell.articles.length === 1) return articleLabel(representative);
  const first = cell.articles[0];
  const last = cell.articles.at(-1) ?? first;
  const state = stateMeta(normalize(representative.state)).label;
  return `Articles ${first.index + 1}–${last.index + 1} (${cell.articles.length} articles): contains ${state}; selects article ${representative.index + 1}`;
}

function articleTitle(article: NormalizedArticle) {
  return [
    `#${article.index + 1}`,
    stateMeta(normalize(article.state)).label,
    article.successfulProvider,
    article.durationMs != null ? formatMs(article.durationMs) : null,
    article.fileName,
    article.articleNumber != null ? `part ${article.articleNumber}` : null,
    article.messageId,
  ].filter(Boolean).join(" · ");
}

function articleCellTitle(cell: ArticleCell, representative = cell.representative) {
  if (cell.articles.length === 1) return articleTitle(representative);
  const first = cell.articles[0];
  const last = cell.articles.at(-1) ?? first;
  return `Articles ${first.index + 1}–${last.index + 1} · ${cell.articles.length} articles · selected ${articleTitle(representative)}`;
}

function stateMeta(state: string) {
  return STATE_META[state] ?? {
    label: state ? humanize(state) : "Unknown",
    cell: "border-muted-foreground/30 bg-muted",
    text: "text-muted-foreground",
  };
}

function StateGlyph({ state, className }: { state: string; className?: string }) {
  const normalized = normalize(state);
  const props = { className, "aria-hidden": true, "data-state-glyph": normalized };
  if (normalized === "pending") return <Circle {...props} />;
  if (normalized === "queued") return <Clock3 {...props} />;
  if (normalized === "downloading") return <Download {...props} />;
  if (normalized === "downloaded") return <Check {...props} />;
  if (normalized === "cached") return <Database {...props} />;
  if (normalized === "failed") return <XCircle {...props} />;
  if (normalized === "partial") return <CircleDashed {...props} />;
  return <CircleDashed {...props} />;
}

function normalize(value?: string | null) {
  return (value ?? "").trim().toLowerCase();
}

function humanize(value: string) {
  return value.replace(/[-_]+/g, " ").replace(/^./, (character) => character.toUpperCase());
}

function formatRate(bytesPerSecond?: number | null) {
  if (bytesPerSecond == null || !Number.isFinite(bytesPerSecond)) return "—";
  return `${formatBytes(Math.max(0, bytesPerSecond))}/s`;
}

function formatPayload(article: ArticleTelemetryResponse) {
  const received = formatBytes(article.bytes);
  if (article.expectedBytes == null || article.expectedBytes <= 0) return received;
  return `${received} / ${formatBytes(article.expectedBytes)}`;
}

function formatPercent(value: number) {
  if (!Number.isFinite(value)) return "0%";
  return `${value.toFixed(value < 10 ? 1 : 0)}%`;
}

function formatTimestamp(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}
