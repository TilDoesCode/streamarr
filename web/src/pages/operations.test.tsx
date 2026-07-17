import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import { setSession } from "@/api/token";
import { LibraryPage } from "./library";
import { EphemeralFilesPage } from "./ephemeral-files";
import { StreamingHistoryPage } from "./streaming-history";

const now = "2026-07-17T12:00:00.000Z";

describe("operations views", () => {
  beforeEach(() => {
    setSession({ username: "admin", role: "admin", expiresAt: "2099-01-01T00:00:00Z" });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/library/releases")) return response([cachedRelease]);
      if (url.includes("/ephemeral-files")) return response([ephemeralFile]);
      if (url.includes("/events")) return response(historyEvents);
      return response({ error: { code: "not_found", message: "not found" } }, 404);
    }));
  });

  afterEach(() => vi.restoreAllMocks());

  it("renders cached release metadata and cache hits", async () => {
    renderWithProviders(<LibraryPage />);
    expect(await screen.findByText(cachedRelease.title)).toBeInTheDocument();
    expect(screen.getByText("7 cache hits")).toBeInTheDocument();
    expect(screen.getByText("1,284 chunks")).toBeInTheDocument();
  });

  it("shows requester, queried chunks, storage and purge clock", async () => {
    renderWithProviders(<EphemeralFilesPage />);
    expect((await screen.findAllByText("Mara")).length).toBeGreaterThan(0);
    expect(screen.getByText(/496 \/ 1,284 chunks queried/)).toBeInTheDocument();
    expect(screen.getByText("496 chunks resident")).toBeInTheDocument();
    expect(screen.getAllByText(/in 45m/).length).toBeGreaterThan(0);
  });

  it("groups Jellyfin events into one user-attributed playback visit", async () => {
    renderWithProviders(<StreamingHistoryPage />);
    expect((await screen.findAllByText("Mara")).length).toBeGreaterThan(0);
    expect(screen.getByText("Living Room TV")).toBeInTheDocument();
    expect(screen.getByText("3 events")).toBeInTheDocument();
    expect(screen.getAllByText(/stopped/i).length).toBeGreaterThan(0);
  });
});

const cachedRelease = {
  releaseId: "rel-1",
  workId: "tmdb-movie-101",
  title: "Silo.2026.2160p.WEB-DL.DDP5.1.DV.HDR.H.265",
  indexer: "NzbHydra",
  releaseSizeBytes: 19_800_000_000,
  nzbSizeBytes: 482_000,
  fileCount: 17,
  segmentCount: 1284,
  hitCount: 7,
  cachedAt: "2026-07-15T12:00:00.000Z",
  lastAccessedAt: now,
};

const ephemeralFile = {
  token: "tok-1",
  releaseId: "rel-1",
  workId: "tmdb-movie-101",
  title: cachedRelease.title,
  fileName: "silo.2026.2160p.mkv",
  state: "ready",
  container: "mkv",
  client: "jellyfin",
  requestedById: "user-1",
  requestedByName: "Mara",
  sizeBytes: 19_800_000_000,
  bytesServed: 7_600_000_000,
  chunksQueried: 496,
  totalChunks: 1284,
  estimatedStreamedPercent: 38.6,
  cachedChunks: 496,
  storageBytes: 7_900_000_000,
  createdAt: now,
  lastAccessedAt: now,
  purgeAt: new Date(Date.now() + 45 * 60_000).toISOString(),
};

const historyEvents = [
  { id: 1, releaseId: "rel-1", workId: "tmdb-movie-101", event: "start", positionTicks: 0, source: "jellyfin", playbackSessionId: "play-1", externalUserId: "user-1", externalUserName: "Mara", deviceName: "Living Room TV", receivedAt: "2026-07-17T10:00:00Z" },
  { id: 2, releaseId: "rel-1", workId: "tmdb-movie-101", event: "progress", positionTicks: 24_000_000_000, source: "jellyfin", playbackSessionId: "play-1", externalUserId: "user-1", externalUserName: "Mara", deviceName: "Living Room TV", receivedAt: "2026-07-17T10:40:00Z" },
  { id: 3, releaseId: "rel-1", workId: "tmdb-movie-101", event: "stop", positionTicks: 48_000_000_000, source: "jellyfin", playbackSessionId: "play-1", externalUserId: "user-1", externalUserName: "Mara", deviceName: "Living Room TV", receivedAt: "2026-07-17T11:20:00Z" },
];

function response(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: new Headers({ "content-type": "application/json" }),
    text: () => Promise.resolve(JSON.stringify(body)),
    clone: () => ({ json: () => Promise.resolve(body) }),
  } as unknown as Response);
}
