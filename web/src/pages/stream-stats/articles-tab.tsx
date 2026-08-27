import { AlertTriangle, Radio } from "lucide-react";
import { ApiError, errorMessage } from "@/api/client";
import type { ArticleMapResponse } from "@/api/types";
import { ArticleMap } from "@/components/article-map";
import { formatTimestamp } from "./format";

export interface ArticleMapQueryState {
  data?: ArticleMapResponse;
  isLoading: boolean;
  isError: boolean;
  isFetching?: boolean;
  error: unknown;
}

/** The "Articles" sub screen: the live article-by-article flight map for the release. */
export function ArticleMapPanel({ state }: { state: ArticleMapQueryState }) {
  if (state.data) {
    return (
      <div>
        {state.isError && (
          <div className="mb-4 flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-xs text-amber-900 dark:text-amber-200" role="status">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <p>
              Live article sampling failed. The last snapshot from {formatTimestamp(state.data.updatedAt)} remains visible: {errorMessage(state.error)}
            </p>
          </div>
        )}
        <ArticleMap data={state.data} />
      </div>
    );
  }

  if (state.isLoading) {
    return (
      <div aria-label="Loading article flight map">
        <div className="h-72 animate-pulse rounded-xl border bg-muted/40" />
      </div>
    );
  }

  const notFound = state.error instanceof ApiError && state.error.status === 404;
  return (
    <div className="flex items-start gap-3 rounded-xl border border-dashed bg-card/70 p-4 text-sm">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Radio className="size-4" />
      </span>
      <div>
        <p className="font-medium text-foreground">
          {notFound ? "No article flight map was retained" : "Article telemetry is unavailable"}
        </p>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
          {notFound
            ? "This stream predates article-level telemetry or its short-lived diagnostic map has expired. The permanent event log below is still available."
            : errorMessage(state.error)}
        </p>
      </div>
    </div>
  );
}
