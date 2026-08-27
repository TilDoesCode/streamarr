import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import { setSession } from "@/api/token";
import { SessionsPage, transferRateBetween } from "./sessions";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

const now = Date.now();

const liveSession = {
  token: "tok-live",
  releaseId: "rel-actual",
  workId: "work-asterion-s02e06",
  title: "Asterion.Station.S02E06.2160p-ORBIT",
  state: "ready",
  container: "mkv",
  sizeBytes: 1_000_000,
  bytesServed: 500_000,
  nntpConnectionsInFlight: 3,
  nntpCommandsTotal: 120,
  client: "jellyfin",
  requestedById: "user-1",
  requestedByName: "Mara Voss",
  createdAt: ago(90_000),
  lastAccessedAt: ago(1_000),
  expiresAt: later(3_600_000),
};

const liveFile = {
  ...liveSession,
  fileName: "Asterion.Station.S02E06.mkv",
  chunksQueried: 4,
  totalChunks: 10,
  estimatedStreamedPercent: 40,
  cachedChunks: 4,
  storageBytes: 400_000,
  retentionPriority: "normal",
  preDownloadJobId: "predownload-1",
  preDownloadState: "downloading",
  preDownloadedBytes: 250_000,
  preDownloadTotalBytes: 1_000_000,
  preDownloadPercent: 25,
  localCacheReady: false,
  isStreaming: false,
  purgeAt: later(3_600_000),
};

const fallbackRecord = {
  token: "tok-live",
  releaseId: "rel-requested",
  workId: "work-asterion-s02e06",
  title: "Asterion.Station.S02E06.1080p-EMBER",
  resolvedReleaseId: "rel-actual",
  resolvedTitle: "Asterion.Station.S02E06.2160p-ORBIT",
  container: "mkv",
  sizeBytes: 1_000_000,
  bytesServed: 500_000,
  nntpCommandsTotal: 120,
  client: "jellyfin",
  requestedById: "user-1",
  requestedByName: "Mara Voss",
  createdAt: ago(90_000),
  closedAt: null,
  finalState: null,
  closeReason: null,
};

const failedRecord = {
  token: "attempt-failed",
  releaseId: "rel-failed",
  workId: "work-asterion-s02e06",
  title: "Asterion.Station.S02E06.2160p-NOVA",
  container: null,
  sizeBytes: 2_000_000,
  bytesServed: 0,
  nntpCommandsTotal: 44,
  client: "jellyfin",
  requestedById: "user-1",
  requestedByName: "Mara Voss",
  createdAt: ago(5 * 60_000),
  closedAt: ago(4 * 60_000),
  finalState: "failed",
  closeReason: "repair failed",
  failureKind: "repair failed",
  failureReason: "Parity reconstruction exhausted the available recovery blocks.",
};

const playbackEvents = [
  {
    id: 1,
    releaseId: "rel-actual",
    workId: "work-asterion-s02e06",
    title: "Asterion.Station.S02E06.2160p-ORBIT",
    event: "progress",
    positionTicks: 24_000_000_000,
    durationTicks: 48_000_000_000,
    sessionToken: "tok-live",
    source: "jellyfin",
    playbackSessionId: "play-tokened",
    externalUserId: "user-1",
    externalUserName: "Mara Voss",
    deviceName: "Living Room TV",
    receivedAt: ago(30_000),
  },
  {
    id: 2,
    releaseId: "rel-actual",
    workId: "work-asterion-s02e06",
    title: "Asterion.Station.S02E06.2160p-ORBIT",
    event: "stop",
    positionTicks: 48_000_000_000,
    durationTicks: 48_000_000_000,
    sessionToken: null,
    source: "jellyfin",
    playbackSessionId: "play-without-token",
    externalUserId: "user-2",
    externalUserName: "Ada",
    deviceName: "Bedroom TV",
    receivedAt: ago(15_000),
  },
];

const metricsSnapshot = {
  sessions: { active: 1, openedTotal: 14, closedTotal: 13 },
  connections: {
    budget: 16,
    inUse: 11,
    providers: [
      {
        name: "Eweka EU",
        priority: 0,
        liveConnections: 8,
        activeConnections: 5,
        idleConnections: 3,
        availableConnections: 7,
        tripped: false,
      },
      {
        name: "Blocknews",
        priority: 1,
        liveConnections: 1,
        activeConnections: 1,
        idleConnections: 0,
        availableConnections: 3,
        tripped: true,
      },
    ],
  },
  resolves: { total: 22, viaFallback: 2 },
  searchCache: { entries: 4, hits: 18, misses: 3, hitRate: 0.8571 },
  bytesServedTotal: 84_734_918,
  indexers: [],
};

const generalConfig = {
  hasTmdbApiKey: false,
  sessionTtlSeconds: 86_400,
  ephemeralCacheSizeMb: 4,
  searchCacheTtlSeconds: 60,
  indexerResultLimit: 1_000,
  segmentCacheSizeMb: 512,
  connectionBudget: 16,
  addStreamarrBadge: true,
  addReleaseScoreToName: false,
};

let sessionRows: unknown[];
let fileRows: unknown[];
let recordRows: unknown[];
let eventRows: unknown[];
let closed: string[];
let purged: string[];
let metricsFail: boolean;
let configFail: boolean;

function installFetch() {
  sessionRows = [liveSession];
  fileRows = [liveFile];
  recordRows = [fallbackRecord, failedRecord];
  eventRows = playbackEvents;
  closed = [];
  purged = [];
  metricsFail = false;
  configFail = false;
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const closeMatch = url.match(/\/sessions\/([^/]+)\/close/);
    const purgeMatch = url.match(/\/ephemeral-files\/([^/]+)\/purge/);
    if (closeMatch && method === "POST") {
      closed.push(decodeURIComponent(closeMatch[1]));
      sessionRows = [];
      fileRows = [];
      return response(undefined, 204);
    }
    if (purgeMatch && method === "POST") {
      purged.push(decodeURIComponent(purgeMatch[1]));
      sessionRows = [];
      fileRows = [];
      return response(undefined, 204);
    }
    if (url.includes("/metrics") && method === "GET") return metricsFail
      ? response({ error: { code: "metrics_unavailable", message: "Telemetry unavailable" } }, 503)
      : response(metricsSnapshot);
    if (url.includes("/config/general") && method === "GET") return configFail
      ? response({ error: { code: "config_unavailable", message: "Configuration unavailable" } }, 503)
      : response(generalConfig);
    if (url.includes("/ephemeral-files") && method === "GET") return response(fileRows);
    if (url.includes("/streams") && method === "GET") return response(recordRows);
    if (url.includes("/events") && method === "GET") return response(eventRows);
    if (url.includes("/sessions") && method === "GET") return response(sessionRows);
    return response({ error: { code: "not_found", message: "no" } }, 404);
  }));
}

describe("Streams page", () => {
  beforeEach(() => {
    setSession({ username: "admin", role: "admin", expiresAt: later(3_600_000) });
    installFetch();
  });

  afterEach(() => vi.restoreAllMocks());

  it("merges live, file, record, and tokened playback data into one work-grouped attempt", async () => {
    renderWithProviders(<SessionsPage />);

    expect(await screen.findByRole("heading", { name: "Streams" })).toBeInTheDocument();
    await screen.findByText("Living Room TV");
    expect(screen.getByTitle("work-asterion-s02e06")).toBeInTheDocument();
    expect(screen.getByText("2 attempts")).toBeInTheDocument();
    expect(screen.getAllByText("Asterion.Station.S02E06.2160p-ORBIT").length).toBeGreaterThan(0);
    expect(screen.getByText(/requested \/ Asterion\.Station\.S02E06\.1080p-EMBER · rel-requested/)).toBeInTheDocument();
    expect(screen.getByText("Living Room TV")).toBeInTheDocument();
    expect(screen.getByText("normal retention")).toBeInTheDocument();
  });

  it("keeps cache, client output, and provider connection pressure compact in the hero", async () => {
    renderWithProviders(<SessionsPage />);

    const overview = await screen.findByRole("region", { name: "Current system load" });
    expect(await within(overview).findByText("24%")).toBeInTheDocument();
    expect(within(overview).getByText("977 KB / 4.0 MB · 1 file")).toBeInTheDocument();
    expect(within(overview).getByRole("progressbar", { name: "Stream cache allocation" })).toHaveAttribute("aria-valuenow", "24");
    expect(within(overview).getByText("Measuring…")).toBeInTheDocument();
    expect(within(overview).getByText("0", { selector: "p" })).toBeInTheDocument();
    expect(within(overview).getByText("6 / 16")).toBeInTheDocument();
    expect(within(overview).getByText("5 / 12")).toBeInTheDocument();
    expect(within(overview).getByText("1 / 4")).toBeInTheDocument();
    expect(within(overview).getByText("failover · 1 live socket · 0 idle")).toBeInTheDocument();
  });

  it("derives current output from consecutive monotonic counter samples", () => {
    expect(transferRateBetween({ bytes: 1_000, at: 2_000 }, { bytes: 5_000, at: 4_000 })).toBe(2_000);
    expect(transferRateBetween({ bytes: 5_000, at: 4_000 }, { bytes: 5_000, at: 6_000 })).toBe(0);
    expect(transferRateBetween({ bytes: 5_000, at: 6_000 }, { bytes: 200, at: 8_000 })).toBeNull();
    expect(transferRateBetween({ bytes: 200, at: 8_000 }, { bytes: 1_200, at: 30_000 })).toBeNull();
  });

  it("keeps the stream ledger usable when load telemetry is unavailable", async () => {
    metricsFail = true;
    configFail = true;
    renderWithProviders(<SessionsPage />);

    expect(await screen.findByText("Some stream data could not refresh")).toBeInTheDocument();
    expect(screen.getByText("Provider telemetry is temporarily unavailable.")).toBeInTheDocument();
    expect(screen.getByText("Cache allocation could not load")).toBeInTheDocument();
    expect(screen.getByText("Living Room TV")).toBeInTheDocument();
  });

  it("keeps tokenless playback visible without guessing it onto an attempt", async () => {
    renderWithProviders(<SessionsPage />);

    expect(await screen.findByText(/No stream token was reported/i)).toBeInTheDocument();
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.getByText("2 attempts")).toBeInTheDocument();
  });

  it("shows destructive failure metadata for failed repair, article, or stream outcomes", async () => {
    renderWithProviders(<SessionsPage />);

    const reason = await screen.findByText("Parity reconstruction exhausted the available recovery blocks.");
    const card = reason.closest("article")!;
    expect(within(card).getByText("repair failed", { selector: "span" })).toHaveClass("bg-destructive");
    expect(within(card).getByText("Asterion.Station.S02E06.2160p-NOVA")).toBeInTheDocument();
  });

  it("uses byte delivery as canonical progress and keeps chunk and disk percentages secondary in both modes", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SessionsPage />);

    const payload = await screen.findByRole("progressbar", { name: /payload delivered for Asterion\.Station\.S02E06\.2160p-ORBIT/i });
    expect(payload).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByText("40%", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("25%", { exact: true })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /table/i }));
    const table = screen.getByRole("table", { name: /streams grouped by work/i });
    expect(table).toHaveClass("w-full", "min-w-[88rem]");
    const row = within(table).getByTitle("rel-actual").closest("tr")!;
    expect(within(row).getByText("50%", { exact: true })).toBeInTheDocument();
    expect(within(row).getByText("40%", { exact: true })).toBeInTheDocument();
    expect(within(row).getByText("25%", { exact: true })).toBeInTheDocument();
  });

  it("keeps close and purge controls on the merged attempt", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SessionsPage />);
    await screen.findByText("Living Room TV");

    await user.click(screen.getByRole("button", { name: /force-close session/i }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(closed).toEqual(["tok-live"]));
  });
});

function response(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: new Headers(body === undefined ? {} : { "content-type": "application/json" }),
    text: () => Promise.resolve(body === undefined ? "" : JSON.stringify(body)),
    clone: () => ({ json: () => Promise.resolve(body) }),
  } as unknown as Response);
}

function ago(milliseconds: number) {
  return new Date(now - milliseconds).toISOString();
}

function later(milliseconds: number) {
  return new Date(now + milliseconds).toISOString();
}
