import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ArticleMapResponse } from "@/api/types";
import { ArticleMap } from "./article-map";
import { renderWithProviders } from "@/test/render";

const articleMap = {
  releaseId: "Asterion.Station.S02E06.2160p-ORBIT",
  totalArticles: 6,
  pendingArticles: 1,
  activeArticles: 1,
  downloadedArticles: 1,
  cachedArticles: 2,
  failedArticles: 1,
  downloadedBytes: 3_670_016,
  averageDurationMs: 420,
  effectiveBytesPerSecond: 8_388_608,
  updatedAt: "2026-08-17T14:22:31Z",
  providers: [
    { provider: "Eweka EU", successes: 3, missing: 1, errors: 0, averageDurationMs: 184 },
    { provider: "Blocknews", successes: 1, missing: 0, errors: 1, averageDurationMs: 640 },
  ],
  articles: [
    {
      index: 0,
      messageId: "part-0001@asterion.example",
      state: "downloaded",
      bytes: 768_000,
      durationMs: 180,
      throughputBytesPerSecond: 4_266_666,
      startedAt: "2026-08-17T14:22:20Z",
      completedAt: "2026-08-17T14:22:20.180Z",
      successfulProvider: "Eweka EU",
      attempts: [
        { provider: "Eweka EU", operation: "BODY", outcome: "success", durationMs: 180, responseCode: 222 },
      ],
    },
    {
      index: 1,
      messageId: "part-0002@asterion.example",
      state: "downloading",
      bytes: 768_000,
      startedAt: "2026-08-17T14:22:30Z",
      attempts: [
        { provider: "Eweka EU", operation: "BODY", outcome: "success", durationMs: 210, responseCode: 222 },
      ],
    },
    {
      index: 2,
      messageId: "part-0003@asterion.example",
      state: "cached",
      bytes: 768_000,
      durationMs: 0,
      throughputBytesPerSecond: 0,
      successfulProvider: "segment cache",
      attempts: [],
    },
    {
      index: 3,
      messageId: "part-0004@asterion.example",
      fileName: "Asterion.Station.part01.rar",
      articleNumber: 4,
      expectedBytes: 800_000,
      state: "failed",
      bytes: 768_000,
      durationMs: 2_420,
      errorType: "article_not_found",
      errorMessage: "No configured provider retained this article.",
      attempts: [
        {
          provider: "Eweka EU",
          operation: "BODY",
          outcome: "missing",
          durationMs: 170,
          responseCode: 430,
          errorType: "nntp_430",
          errorMessage: "430 No article with that message-id",
        },
        {
          provider: "Blocknews",
          operation: "BODY",
          outcome: "error",
          durationMs: 2_250,
          errorType: "connection_timeout",
          errorMessage: "The provider did not answer before the command timeout.",
        },
      ],
    },
    {
      index: 4,
      messageId: "part-0005@asterion.example",
      state: "cached",
      bytes: 598_016,
      durationMs: 110,
      throughputBytesPerSecond: 5_436_509,
      successfulProvider: "Eweka EU",
      attempts: [
        { provider: "Eweka EU", operation: "BODY", outcome: "success", durationMs: 110, responseCode: 222 },
      ],
    },
    {
      index: 5,
      messageId: "part-0006@asterion.example",
      state: "pending",
      bytes: 768_000,
      attempts: [],
    },
  ],
} as unknown as ArticleMapResponse;

describe("ArticleMap", () => {
  it("renders the aggregate flight deck, provider lanes, and every ordered article", () => {
    renderWithProviders(<ArticleMap data={articleMap} />);

    expect(screen.getByRole("heading", { name: "Every article, one live signal" })).toBeInTheDocument();
    expect(screen.getByText("3 / 6")).toBeInTheDocument();
    expect(screen.getByText("8.0 MB/s")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Provider outcomes" })).toHaveTextContent("Eweka EU");

    const map = screen.getByRole("list", { name: "Articles in release order" });
    const cells = within(map).getAllByRole("button");
    expect(cells).toHaveLength(6);
    expect(cells.map((cell) => cell.getAttribute("data-article-index"))).toEqual(["0", "1", "2", "3", "4", "5"]);
    expect(within(map).getByRole("button", { name: /article 2: downloading/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { name: "Article 2" })).toBeInTheDocument();
  });

  it("keeps the complete map visible while focusing failed articles", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ArticleMap data={articleMap} />);

    await user.click(screen.getByRole("button", { name: /failed 1/i }));

    const map = screen.getByRole("list", { name: "Articles in release order" });
    expect(within(map).getAllByRole("button")).toHaveLength(6);
    expect(within(map).getByRole("button", { name: /article 4: failed/i })).toHaveAttribute("data-filter-match", "true");
    expect(within(map).getByRole("button", { name: /article 1: downloaded/i })).toHaveAttribute("data-filter-match", "false");
    expect(screen.getByText(/1 failed · all cells retained for context/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Article 4" })).toBeInTheDocument();
  });

  it("shows exact provider failures and copies the selected message id", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderWithProviders(<ArticleMap data={articleMap} />);

    await user.click(screen.getByRole("button", { name: /article 4: failed/i }));

    expect(screen.getByRole("heading", { name: "Article 4" })).toBeInTheDocument();
    expect(screen.getByText("Asterion.Station.part01.rar / part 4")).toBeInTheDocument();
    expect(screen.getByText("750 KB / 781 KB")).toBeInTheDocument();
    expect(screen.getByText("part-0004@asterion.example")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("No configured provider retained this article.");
    const attempts = screen.getByRole("list", { name: "Provider attempts for article 4" });
    expect(attempts).toHaveTextContent("Eweka EU");
    expect(attempts).toHaveTextContent("430");
    expect(attempts).toHaveTextContent("Blocknews");
    expect(attempts).toHaveTextContent("connection_timeout");

    await user.click(screen.getByRole("button", { name: "Copy article message ID" }));
    expect(writeText).toHaveBeenCalledWith("part-0004@asterion.example");
  });

  it("supports roving keyboard inspection in release order", () => {
    renderWithProviders(<ArticleMap data={articleMap} />);

    const current = screen.getByRole("button", { name: /article 2: downloading/i });
    current.focus();
    fireEvent.keyDown(current, { key: "ArrowRight" });

    expect(screen.getByRole("button", { name: /article 3: cached/i })).toHaveFocus();
    expect(screen.getByRole("heading", { name: "Article 3" })).toBeInTheDocument();
  });

  it("uses distinct state glyphs in both the map and legend", () => {
    renderWithProviders(<ArticleMap data={articleMap} />);

    const map = screen.getByRole("list", { name: "Articles in release order" });
    for (const state of ["pending", "downloading", "downloaded", "cached", "failed"]) {
      const cell = map.querySelector(`[data-article-state="${state}"]`);
      expect(cell?.querySelector(`[data-state-glyph="${state}"]`)).not.toBeNull();
    }

    const legend = document.querySelector('[aria-label="Article state legend"]');
    for (const state of ["pending", "queued", "downloading", "downloaded", "cached", "failed", "partial"])
      expect(legend?.querySelector(`[data-state-glyph="${state}"]`)).not.toBeNull();
  });

  it("renders telemetry truncation as untracked instead of pending coverage", () => {
    const articles = articleMap.articles!.slice(0, 2).map((article, index) => ({
      ...article,
      index,
      state: "downloaded",
      durationMs: 120,
      bytes: 768_000,
    }));
    const data = {
      ...articleMap,
      totalArticles: 10,
      trackedArticles: 2,
      truncatedArticles: 8,
      pendingArticles: 0,
      activeArticles: 0,
      partialArticles: 0,
      downloadedArticles: 2,
      cachedArticles: 0,
      failedArticles: 0,
      articles,
    } as ArticleMapResponse;

    renderWithProviders(<ArticleMap data={data} />);

    const coverage = screen.getByRole("progressbar", { name: "Article completion" });
    expect(coverage.querySelector('[data-coverage-segment="pending"]')).toBeNull();
    expect(coverage.querySelector('[data-coverage-segment="untracked"]')).toHaveStyle({ width: "80%" });
    expect(coverage).toHaveAttribute("aria-valuetext", "2 confirmed complete of 10; 8 untracked or unknown");
    expect(screen.getByText("8 untracked / unknown")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("2 of 10 articles carry per-article telemetry");
  });

  it("derives a robust slow threshold only from successful downloads", async () => {
    const user = userEvent.setup();
    const durations = [100, 110, 120, 130, 5_000];
    const downloaded = durations.map((durationMs, index) => ({
      index,
      messageId: `downloaded-${index}@slow.example`,
      state: "downloaded",
      bytes: 768_000,
      durationMs,
      attempts: [],
    }));
    const data = {
      ...articleMap,
      totalArticles: 7,
      trackedArticles: 7,
      truncatedArticles: 0,
      pendingArticles: 0,
      activeArticles: 0,
      partialArticles: 0,
      downloadedArticles: downloaded.length,
      cachedArticles: 1,
      failedArticles: 1,
      averageDurationMs: 50_000,
      articles: [
        ...downloaded,
        { index: 5, messageId: "cached@slow.example", state: "cached", bytes: 768_000, durationMs: 0, attempts: [] },
        { index: 6, messageId: "failed@slow.example", state: "failed", bytes: 0, durationMs: 900, attempts: [] },
      ],
      providers: [],
    } as unknown as ArticleMapResponse;

    renderWithProviders(<ArticleMap data={data} />);

    const slow = screen.getByRole("button", { name: /slow 1/i });
    expect(slow).toHaveAttribute("title", "Slower than 1.00 s");
    await user.click(slow);
    expect(screen.getByRole("heading", { name: "Article 5" })).toBeInTheDocument();
  });

  it("densely represents large manifests without losing a failed article", () => {
    const lastIndex = 5_000;
    const articles = Array.from({ length: lastIndex + 1 }, (_, index) => ({
      index,
      messageId: `part-${String(index + 1).padStart(5, "0")}@large.example`,
      state: index === lastIndex
        ? "failed"
        : index === lastIndex - 1 || index < 3
          ? "downloaded"
          : "pending",
      bytes: index === lastIndex - 1 || index < 3 ? 768_000 : 0,
      durationMs: index === lastIndex - 1
        ? 5_000
        : index < 3
          ? 100 + index * 10
          : index === lastIndex
            ? 100
            : null,
      errorType: index === lastIndex ? "article_not_found" : null,
      errorMessage: index === lastIndex ? "The final article is missing on every provider." : null,
      attempts: [],
    }));
    const data = {
      ...articleMap,
      totalArticles: articles.length,
      pendingArticles: articles.length - 5,
      activeArticles: 0,
      downloadedArticles: 4,
      cachedArticles: 0,
      failedArticles: 1,
      downloadedBytes: 0,
      articles,
      providers: [],
    } as unknown as ArticleMapResponse;

    renderWithProviders(<ArticleMap data={data} />);

    const map = screen.getByRole("list", { name: "Articles in release order" });
    const cells = map.querySelectorAll<HTMLButtonElement>("button");
    expect(cells.length).toBeLessThanOrEqual(2_500);
    const failedCell = map.querySelector<HTMLButtonElement>('[data-article-state="failed"]');
    expect(failedCell).not.toBeNull();
    expect(Number(failedCell?.getAttribute("data-bin-size"))).toBeGreaterThan(1);
    expect(failedCell).toHaveAccessibleName(/articles .*: contains failed; selects article 5001/i);

    fireEvent.click(failedCell!);
    expect(screen.getByRole("heading", { name: "Article 5001" })).toBeInTheDocument();
    expect(screen.getByText("The final article is missing on every provider.")).toBeInTheDocument();

    const exactArticle = screen.getByLabelText("Exact article within grouped cell");
    expect(exactArticle).toHaveValue("5000");
    fireEvent.change(exactArticle, { target: { value: "4999" } });
    expect(screen.getByRole("heading", { name: "Article 5000" })).toBeInTheDocument();
    expect(failedCell).toHaveAttribute("aria-pressed", "true");
    expect(failedCell).toHaveAttribute("data-article-index", "4999");
    expect(failedCell).toHaveAttribute("data-article-state", "downloaded");
    expect(failedCell).toHaveAccessibleName(/selects article 5000/i);

    fireEvent.click(failedCell!);
    expect(screen.getByRole("heading", { name: "Article 5000" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /slow 1/i }));
    expect(screen.getByRole("heading", { name: "Article 5000" })).toBeInTheDocument();
    expect(failedCell).toHaveAttribute("data-article-state", "downloaded");
  }, 15_000);
});
