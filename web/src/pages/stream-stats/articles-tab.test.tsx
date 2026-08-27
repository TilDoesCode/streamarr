import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { ApiError } from "@/api/client";
import { renderWithProviders } from "@/test/render";
import { ArticleMapPanel, type ArticleMapQueryState } from "./articles-tab";

const now = Date.now();

const articleMap = {
  releaseId: "Asterion.Station.S02E06.2160p.WEB-DL.DDP5.1.HDR.HEVC-ORBIT",
  totalArticles: 4,
  pendingArticles: 1,
  activeArticles: 1,
  downloadedArticles: 1,
  cachedArticles: 0,
  failedArticles: 1,
  downloadedBytes: 1_536_000,
  averageDurationMs: 310,
  effectiveBytesPerSecond: 5_120_000,
  updatedAt: new Date(now - 250).toISOString(),
  providers: [
    { provider: "Eweka EU", successes: 2, missing: 1, errors: 0, averageDurationMs: 190 },
    { provider: "Blocknews", successes: 0, missing: 1, errors: 0, averageDurationMs: 430 },
  ],
  articles: [
    {
      index: 0,
      messageId: "article-001@asterion.example",
      state: "downloaded",
      bytes: 768_000,
      durationMs: 150,
      successfulProvider: "Eweka EU",
      attempts: [{ provider: "Eweka EU", operation: "BODY", outcome: "success", durationMs: 150, responseCode: 222 }],
    },
    {
      index: 1,
      messageId: "article-002@asterion.example",
      state: "downloading",
      bytes: 220_000,
      durationMs: 420,
      successfulProvider: "Eweka EU",
      attempts: [{ provider: "Eweka EU", operation: "BODY", outcome: "success", durationMs: 180, responseCode: 222 }],
    },
    {
      index: 2,
      messageId: "article-003@asterion.example",
      state: "failed",
      bytes: 0,
      durationMs: 620,
      errorType: "UsenetArticleNotFoundException",
      errorMessage: "No configured provider retained this article.",
      attempts: [
        { provider: "Eweka EU", operation: "BODY", outcome: "missing", durationMs: 190, responseCode: 430 },
        { provider: "Blocknews", operation: "BODY", outcome: "missing", durationMs: 430, responseCode: 430 },
      ],
    },
    { index: 3, messageId: "article-004@asterion.example", state: "pending", bytes: 0, attempts: [] },
  ],
};

function state(overrides: Partial<ArticleMapQueryState>): ArticleMapQueryState {
  return { data: undefined, isLoading: false, isError: false, isFetching: false, error: undefined, ...overrides };
}

describe("ArticleMapPanel", () => {
  it("renders every article as a live signal", () => {
    renderWithProviders(<ArticleMapPanel state={state({ data: articleMap })} />);
    expect(screen.getByRole("heading", { name: "Every article, one live signal" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /article 3: failed/i })).toBeInTheDocument();
  });

  it("keeps the last snapshot visible and warns when live sampling fails", () => {
    const error = new ApiError(503, "telemetry_unavailable", "The article sampler is temporarily unavailable.", null);
    renderWithProviders(<ArticleMapPanel state={state({ data: articleMap, isError: true, error })} />);
    expect(screen.getByRole("heading", { name: "Every article, one live signal" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Live article sampling failed");
    expect(screen.getByRole("button", { name: /article 3: failed/i })).toBeInTheDocument();
  });

  it("shows a loading placeholder while the flight map is still fetching", () => {
    renderWithProviders(<ArticleMapPanel state={state({ isLoading: true })} />);
    expect(screen.getByLabelText("Loading article flight map")).toBeInTheDocument();
  });

  it("explains that no article-level telemetry was retained for older streams", () => {
    const error = new ApiError(404, "unknown_stream", "No retained article map for this token.", null);
    renderWithProviders(<ArticleMapPanel state={state({ error })} />);
    expect(screen.getByText("No article flight map was retained")).toBeInTheDocument();
  });
});
