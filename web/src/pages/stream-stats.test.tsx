import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { renderWithProviders } from "@/test/render";
import { setSession } from "@/api/token";
import { queryKeys } from "@/api/queries";
import { StreamStatsPage } from "./stream-stats";

vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({}),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

const token = "stream-capability-token";
const now = Date.now();
const liveSession = {
  token,
  releaseId: "Asterion.Station.S02E06.2160p.WEB-DL.DDP5.1.HDR.HEVC-ORBIT",
  workId: "tvdb:438271:s02e06",
  state: "ready",
  container: "mkv",
  sizeBytes: 18_643_921_810,
  bytesServed: 7_829_154_816,
  nntpConnectionsInFlight: 2,
  nntpCommandsTotal: 1_482,
  client: "jellyfin",
  requestedById: "jf-user-7b29",
  requestedByName: "Mara Voss",
  createdAt: new Date(now - 18 * 60_000).toISOString(),
  lastAccessedAt: new Date(now - 1_500).toISOString(),
  expiresAt: new Date(now + 42 * 60_000).toISOString(),
};

const liveFile = {
  ...liveSession,
  title: "Asterion Station — The Quiet Array",
  fileName: "Asterion.Station.S02E06.The.Quiet.Array.2160p.mkv",
  chunksQueried: 1_847,
  totalChunks: 4_392,
  estimatedStreamedPercent: 42.05,
  cachedChunks: 612,
  storageBytes: 2_841_772_032,
  purgeAt: liveSession.expiresAt,
};

const historicalRecord = {
  token,
  releaseId: liveSession.releaseId,
  workId: liveSession.workId,
  title: "Asterion Station — The Quiet Array",
  container: "mkv",
  sizeBytes: liveSession.sizeBytes,
  bytesServed: liveSession.bytesServed,
  nntpCommandsTotal: liveSession.nntpCommandsTotal,
  client: "jellyfin",
  requestedById: liveSession.requestedById,
  requestedByName: liveSession.requestedByName,
  createdAt: new Date(now - 40 * 60_000).toISOString(),
  closedAt: new Date(now - 20 * 60_000).toISOString(),
  finalState: "closed",
  closeReason: null,
  timelineStartedAt: new Date(now - 40 * 60_000).toISOString(),
  timeline: [
    { name: "nzb-fetch", category: "nzb", startMs: 0, durationMs: 42, detail: "cache" },
  ],
  events: [
    { atUtc: new Date(now - 40 * 60_000).toISOString(), source: "ttff", category: "nzb", name: "nzb-fetch", detail: "cache" },
    { atUtc: new Date(now - 39 * 60_000).toISOString(), source: "repair", category: "Failed", name: "Failed", detail: "failed: the release carries no PAR2 set" },
    { atUtc: new Date(now - 20 * 60_000).toISOString(), source: "lifecycle", category: "closed", name: "closed", detail: null },
  ],
};

const liveArticleMap = {
  releaseId: liveSession.releaseId,
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

const nextEpisodeJob = {
  id: "job-next-episode-7",
  state: "downloading",
  kind: "nextEpisode",
  reason: "Watch progress reached 75%",
  priority: "low",
  sourceToken: token,
  sourceReleaseId: liveSession.releaseId,
  sourceWorkId: liveSession.workId,
  targetToken: "prepared-episode-token",
  targetReleaseId: "Asterion.Station.S02E07.2160p.WEB-DL-ORBIT",
  targetWorkId: "tvdb:438271:s02e07",
  targetTitle: "Asterion Station — Signal in the Dust",
  targetSeasonNumber: 2,
  targetEpisodeNumber: 7,
  bytesDownloaded: 7_158_266_838,
  totalBytes: 18_643_921_810,
  progressPercent: 38.4,
  watchPositionTicks: 18_300_000_000,
  watchDurationTicks: 24_000_000_000,
  watchProgressPercent: 76.25,
  triggerThreshold: 75,
  triggerUnit: "percent",
  queuedAt: new Date(now - 45_000).toISOString(),
  startedAt: new Date(now - 42_000).toISOString(),
  updatedAt: new Date(now - 1_000).toISOString(),
};

const skippedTargetJob = {
  ...nextEpisodeJob,
  id: "job-target-skipped",
  state: "skipped",
  sourceToken: "originating-playback-token",
  sourceWorkId: "tvdb:438271:s02e05",
  targetToken: token,
  targetWorkId: liveSession.workId,
  targetTitle: "Asterion Station — The Quiet Array",
  targetSeasonNumber: 2,
  targetEpisodeNumber: 6,
  bytesDownloaded: 0,
  totalBytes: 0,
  progressPercent: 0,
  errorCode: "capacity",
  errorMessage: "The implicit download could not fit without displacing active content.",
  completedAt: new Date(now - 500).toISOString(),
};

function response(body: unknown): Promise<Response> {
  return Promise.resolve({
    ok: true,
    status: 200,
    statusText: "",
    headers: new Headers({ "content-type": "application/json" }),
    text: () => Promise.resolve(JSON.stringify(body)),
    clone: () => ({ json: () => Promise.resolve(body) }),
  } as unknown as Response);
}

function notFoundResponse(): Promise<Response> {
  const body = { error: { code: "unknown_stream", message: "No retained stream record exists for this token." } };
  return Promise.resolve({
    ok: false,
    status: 404,
    statusText: "Not Found",
    headers: new Headers({ "content-type": "application/json" }),
    text: () => Promise.resolve(JSON.stringify(body)),
    clone: () => ({ json: () => Promise.resolve(body) }),
  } as unknown as Response);
}

function errorResponse(message = "The article sampler is temporarily unavailable."): Promise<Response> {
  const body = { error: { code: "telemetry_unavailable", message } };
  return Promise.resolve({
    ok: false,
    status: 503,
    statusText: "Service Unavailable",
    headers: new Headers({ "content-type": "application/json" }),
    text: () => Promise.resolve(JSON.stringify(body)),
    clone: () => ({ json: () => Promise.resolve(body) }),
  } as unknown as Response);
}

function installFetch(
  sessions: unknown[] = [liveSession],
  files: unknown[] = [liveFile],
  streamRecord: unknown | "not-found" = "not-found",
  articleMap: unknown | "not-found" | "error" = liveArticleMap,
  preDownloads: unknown[] | "error" | "pending" = [],
) {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/ephemeral-files")) return response(files);
    if (url.includes("/pre-downloads")) {
      if (preDownloads === "pending") return new Promise<Response>(() => undefined);
      return preDownloads === "error"
        ? errorResponse("The pre-download job sampler is temporarily unavailable.")
        : response(preDownloads);
    }
    if (url.includes(`/sessions/${token}/articles`)) {
      if (articleMap === "not-found") return notFoundResponse();
      return articleMap === "error" ? errorResponse() : response(articleMap);
    }
    if (url.includes(`/streams/${token}`)) {
      return streamRecord === "not-found" ? notFoundResponse() : response(streamRecord);
    }
    if (url.includes("/sessions")) return response(sessions);
    if (url.includes("/metrics")) return response({
      sessions: { active: 3, openedTotal: 89, closedTotal: 86 },
      connections: { budget: 16, inUse: 12, providers: [{ name: "Eweka EU", activeConnections: 7, tripped: false }] },
      resolves: { total: 102, viaFallback: 4 },
      searchCache: { entries: 40, hits: 71, misses: 12, hitRate: 0.855 },
      bytesServedTotal: 91_842_816_037,
      indexers: [],
    });
    if (url.includes("/logs")) return response({
      entries: [],
      sources: [
        { source: "core", configured: true, available: true },
        { source: "jellyfin", configured: false, available: false },
      ],
      generatedAt: new Date(now).toISOString(),
      hasMore: false,
    });
    if (url.includes("/events")) return response([{
      id: 71,
      releaseId: liveSession.releaseId,
      workId: liveSession.workId,
      event: "progress",
      positionTicks: 18_420_000_000,
      source: "jellyfin",
      playbackSessionId: "jf-playback-55",
      externalUserName: "Mara Voss",
      deviceName: "Shield TV Pro",
      receivedAt: new Date(now - 30_000).toISOString(),
    }]);
    return response([]);
  }));
}

describe("StreamStatsPage", () => {
  beforeEach(() => {
    setSession({ username: "admin", role: "admin", expiresAt: new Date(now + 60 * 60_000).toISOString() });
    vi.stubGlobal("ResizeObserver", class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("renders live transfer, cache, NNTP, identity and correlated playback telemetry", async () => {
    installFetch();
    renderWithProviders(<StreamStatsPage sessionToken={token} />);

    expect(await screen.findByRole("heading", { name: "Asterion Station — The Quiet Array" })).toBeInTheDocument();
    expect(screen.getByText(/1[,.]482/)).toBeInTheDocument();
    expect(screen.getByText("Mara Voss")).toBeInTheDocument();
    expect(screen.getByText("12/16 global · 1/1 providers ready")).toBeInTheDocument();
    expect(screen.getByText("Shield TV Pro", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("video/x-matroska")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Every article, one live signal" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /article 3: failed/i })).toBeInTheDocument();
    expect(screen.getByText("No pre-download has been triggered for this session")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Core & Jellyfin logs" })).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([input]) =>
      String(input) === `/api/v1/pre-downloads?sessionToken=${encodeURIComponent(token)}`,
    )).toBe(true);
    expect(vi.mocked(fetch).mock.calls.some(([input]) =>
      String(input) === `/api/v1/logs?source=all&minimumLevel=information&streamToken=${encodeURIComponent(token)}&limit=100`,
    )).toBe(true);
  });

  it("separates source watch intent from disk progress and identifies prepared targets", async () => {
    installFetch([liveSession], [liveFile], "not-found", liveArticleMap, [nextEpisodeJob, skippedTargetJob]);
    renderWithProviders(<StreamStatsPage sessionToken={token} />);

    expect(await screen.findByRole("heading", { name: "Pre-download diagnostics" })).toBeInTheDocument();
    expect(screen.getByText("source session")).toBeInTheDocument();
    expect(screen.getByText("prepared target")).toBeInTheDocument();
    expect(screen.getByText("S02E07 · Asterion Station — Signal in the Dust")).toBeInTheDocument();
    expect(screen.getAllByRole("progressbar", { name: /client-reported watch progress/i })[0]).toHaveAttribute("aria-valuenow", "76");
    expect(screen.getAllByRole("progressbar", { name: /ephemeral disk pre-download progress/i })[0]).toHaveAttribute("aria-valuenow", "38");
    expect(screen.getAllByText(/never inferred from download bytes/i).length).toBeGreaterThan(0);
    expect(screen.getByText("capacity")).toBeInTheDocument();
    expect(screen.getByText(/could not fit without displacing active content/i)).toBeInTheDocument();
  });

  it("keeps the stream console available while job telemetry is still loading", async () => {
    installFetch([liveSession], [liveFile], "not-found", liveArticleMap, "pending");
    renderWithProviders(<StreamStatsPage sessionToken={token} />);

    expect(await screen.findByRole("heading", { name: "Asterion Station — The Quiet Array" })).toBeInTheDocument();
    expect(screen.getByLabelText("Loading pre-download jobs")).toBeInTheDocument();
  });

  it("shows a typed job telemetry error without hiding the rest of the session", async () => {
    installFetch([liveSession], [liveFile], "not-found", liveArticleMap, "error");
    renderWithProviders(<StreamStatsPage sessionToken={token} />);

    expect(await screen.findByText("Pre-download telemetry is unavailable")).toBeInTheDocument();
    expect(screen.getByText("The pre-download job sampler is temporarily unavailable.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Asterion Station — The Quiet Array" })).toBeInTheDocument();
  });

  it("retains the last job snapshot and marks it stale when a refresh fails", async () => {
    installFetch([liveSession], [liveFile], "not-found", liveArticleMap, "error");
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData(queryKeys.preDownloads(token), [nextEpisodeJob]);

    renderWithProviders(<StreamStatsPage sessionToken={token} />, { queryClient });

    expect(await screen.findByText(/showing the last job snapshot/i)).toBeInTheDocument();
    expect(screen.getByText("S02E07 · Asterion Station — Signal in the Dust")).toBeInTheDocument();
  });

  it("shows an explicit not-found state when neither a live session nor a retained record exist", async () => {
    installFetch([], [], "not-found");
    renderWithProviders(<StreamStatsPage sessionToken={token} />);

    expect(await screen.findByRole("heading", { name: "This stream left no trace" })).toBeInTheDocument();
    expect(screen.getByText(/nothing in the permanent stream history/i)).toBeInTheDocument();
  });

  it("keeps the last article snapshot visible and warns when live sampling fails", async () => {
    installFetch([liveSession], [liveFile], "not-found", "error");
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData(queryKeys.sessionArticles(token), liveArticleMap);

    renderWithProviders(<StreamStatsPage sessionToken={token} />, { queryClient });

    expect(await screen.findByRole("heading", { name: "Every article, one live signal" })).toBeInTheDocument();
    expect(await screen.findByRole("status")).toHaveTextContent("Live article sampling failed");
    expect(screen.getByRole("button", { name: /article 3: failed/i })).toBeInTheDocument();
  });

  it("falls back to the permanent stream-history record once the live session is gone", async () => {
    installFetch([], [], historicalRecord);
    renderWithProviders(<StreamStatsPage sessionToken={token} />);

    expect(await screen.findByRole("heading", { name: "Asterion Station — The Quiet Array" })).toBeInTheDocument();
    expect(screen.getByText("retained history")).toBeInTheDocument();
    expect(screen.getAllByText("closed").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Core & Jellyfin logs" })).toBeInTheDocument();
    // the folded-in PAR2 repair failure shows up in the chronological event log
    expect(screen.getByText(/failed: the release carries no PAR2 set/i)).toBeInTheDocument();
    // the ttff span still renders (once in the reused flamegraph, once in the event log)
    expect(screen.getAllByText("nzb-fetch").length).toBeGreaterThan(0);
  });

  it("renders the request→first-frame flamegraph when the session carries a timeline", async () => {
    installFetch([{
      ...liveSession,
      timelineStartedAt: new Date(now - 17 * 60_000).toISOString(),
      timeline: [
        { name: "nzb-fetch", category: "nzb", startMs: 0, durationMs: 42, detail: "cache", source: "server" },
        { name: "health-check", category: "health", startMs: 44, durationMs: 210, detail: "0/24 missing", source: "server" },
        { name: "materialize", category: "materialize", startMs: 44, durationMs: 690, detail: "580 segments", source: "server" },
        { name: "ffprobe", category: "probe", startMs: 736, durationMs: 122, detail: null, source: "server" },
        { name: "stream-first-byte", category: "stream", startMs: 1_240, durationMs: 480, detail: "pos=0", source: "server" },
        { name: "jellyfin-open", category: "client", startMs: 0, durationMs: 1_180, detail: "ready", source: "client" },
      ],
    }]);
    renderWithProviders(<StreamStatsPage sessionToken={token} />);

    await screen.findByRole("heading", { name: "Asterion Station — The Quiet Array" });
    expect(screen.getByText("nzb-fetch")).toBeInTheDocument();
    expect(screen.getByText("stream-first-byte")).toBeInTheDocument();
    expect(screen.getByText("jellyfin-open")).toBeInTheDocument();
  });

  it("omits the flamegraph entirely when the session has no timeline spans", async () => {
    installFetch([{ ...liveSession, timeline: [] }]);
    renderWithProviders(<StreamStatsPage sessionToken={token} />);

    await screen.findByRole("heading", { name: "Asterion Station — The Quiet Array" });
    expect(screen.queryByText("nzb-fetch")).not.toBeInTheDocument();
  });
});
