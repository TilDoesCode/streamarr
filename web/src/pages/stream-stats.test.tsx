import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import { setSession } from "@/api/token";
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

function installFetch(sessions: unknown[] = [liveSession], files: unknown[] = [liveFile]) {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/ephemeral-files")) return response(files);
    if (url.includes("/sessions")) return response(sessions);
    if (url.includes("/metrics")) return response({
      sessions: { active: 3, openedTotal: 89, closedTotal: 86 },
      connections: { budget: 16, inUse: 12, providers: [{ name: "Eweka EU", activeConnections: 7, tripped: false }] },
      resolves: { total: 102, viaFallback: 4 },
      searchCache: { entries: 40, hits: 71, misses: 12, hitRate: 0.855 },
      bytesServedTotal: 91_842_816_037,
      indexers: [],
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
  });

  it("shows an explicit ended state when the live session has expired", async () => {
    installFetch([], []);
    renderWithProviders(<StreamStatsPage sessionToken={token} />);

    expect(await screen.findByRole("heading", { name: "This stream has left the wire" })).toBeInTheDocument();
    expect(screen.getByText(/live-only/i)).toBeInTheDocument();
  });
});
