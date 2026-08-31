import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import { setSession } from "@/api/token";
import { StreamStatsPage } from "./index";

vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({}),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
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

const watchedScope = {
  workId: liveSession.workId,
  title: "Asterion Station — The Quiet Array",
  source: "jellyfin",
  playbackSessionId: "play-1",
  externalUserId: liveSession.requestedById,
  externalUserName: liveSession.requestedByName,
  deviceName: "Apple TV",
  durationTicks: 24_000_000_000,
  positionTicks: 21_600_000_000,
  lastSessionToken: token,
  lastReleaseId: liveSession.releaseId,
  startedAt: new Date(now - 20 * 60_000).toISOString(),
  updatedAt: new Date(now - 5_000).toISOString(),
  ranges: [
    { startTicks: 12_000_000_000, endTicks: 21_600_000_000, sessionToken: token, releaseId: liveSession.releaseId },
  ],
};

function installFetch(
  sessions: unknown[] = [liveSession],
  files: unknown[] = [liveFile],
  streamRecord: unknown | "not-found" = "not-found",
  playbackRanges: unknown[] = [],
) {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/playback-ranges")) return response(playbackRanges);
    if (url.includes("/ephemeral-files")) return response(files);
    if (url.includes("/pre-downloads")) return response([]);
    if (url.includes(`/sessions/${token}/articles`)) return notFoundResponse();
    if (url.includes(`/streams/${token}`)) return streamRecord === "not-found" ? notFoundResponse() : response(streamRecord);
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
      sources: [{ source: "core", configured: true, available: true }],
      generatedAt: new Date(now).toISOString(),
      hasMore: false,
    });
    if (url.includes("/events")) return response([]);
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

  it("renders a loading skeleton while sessions and files are pending", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    renderWithProviders(<StreamStatsPage sessionToken={token} />);
    expect(screen.getByLabelText("Loading stream telemetry")).toBeInTheDocument();
  });

  it("shows a connectivity error when the stream probe cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("network unreachable"))));
    renderWithProviders(<StreamStatsPage sessionToken={token} />);
    expect(await screen.findByRole("heading", { name: "The stream probe could not connect" })).toBeInTheDocument();
  });

  it("shows an explicit not-found state when neither a live session nor a retained record exist", async () => {
    installFetch([], []);
    renderWithProviders(<StreamStatsPage sessionToken={token} />);
    expect(await screen.findByRole("heading", { name: "This stream left no trace" })).toBeInTheDocument();
    expect(screen.getByText(/nothing in the permanent stream history/i)).toBeInTheDocument();
  });

  it("renders the live hero and lets the operator switch between sub screens", async () => {
    const user = userEvent.setup();
    installFetch();
    renderWithProviders(<StreamStatsPage sessionToken={token} />);

    expect(await screen.findByRole("heading", { name: "Asterion Station — The Quiet Array" })).toBeInTheDocument();
    expect(screen.getByText("ready")).toBeInTheDocument();
    expect(screen.getByText(/% of payload/i)).toBeInTheDocument();

    // Performance is the default sub screen: metrics + TTFF are visible without clicking a tab.
    expect(screen.getByText("NNTP commands")).toBeInTheDocument();
    expect(screen.queryByText("Mara Voss")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Logs" }));
    expect(screen.getByRole("heading", { name: "Core & Jellyfin logs" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Network & session" }));
    expect(screen.getByText("Mara Voss")).toBeInTheDocument();
    expect(screen.getByText("video/x-matroska")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Pre-downloads" }));
    expect(screen.getByText("No pre-download has been triggered for this session")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Articles" }));
    expect(screen.getByText("No article flight map was retained")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Events" }));
    expect(screen.getByText(/no correlated playback events/i)).toBeInTheDocument();
  });

  it("renders the watched timeline from jellyfin playback time, not payload", async () => {
    installFetch([liveSession], [liveFile], "not-found", [watchedScope]);
    renderWithProviders(<StreamStatsPage sessionToken={token} />);

    expect(await screen.findByText("Watched · jellyfin time")).toBeInTheDocument();
    // 9.6 of 24 minutes watched → 40%, playhead at 90% — a mid-file entry stays mid-file.
    expect(
      await screen.findByRole("img", { name: /watched 40% of the timeline, playhead at 90%/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/buffered from usenet/i)).toBeInTheDocument();
    expect(screen.getByText(/delivered to client/i)).toBeInTheDocument();
  });

  it("keeps the watched timeline on the historical console after the session is gone", async () => {
    installFetch([], [], historicalRecord, [watchedScope]);
    renderWithProviders(<StreamStatsPage sessionToken={token} />);

    expect(await screen.findByText(/watched via this stream/i)).toBeInTheDocument();
    expect(
      await screen.findByRole("img", { name: /watched 40% of the timeline via this stream/i }),
    ).toBeInTheDocument();
  });

  it("falls back to the permanent stream-history record once the live session is gone", async () => {
    const user = userEvent.setup();
    installFetch([], [], historicalRecord);
    renderWithProviders(<StreamStatsPage sessionToken={token} />);

    expect(await screen.findByRole("heading", { name: "Asterion Station — The Quiet Array" })).toBeInTheDocument();
    expect(screen.getByText("retained history")).toBeInTheDocument();
    expect(screen.getAllByText("closed").length).toBeGreaterThan(0);
    // no live data path for a retained (non-live) stream
    expect(screen.queryByRole("tab", { name: "Network & session" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Events" }));
    expect(screen.getByText(/failed: the release carries no PAR2 set/i)).toBeInTheDocument();
  });
});
