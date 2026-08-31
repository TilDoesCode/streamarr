import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import { setSession } from "@/api/token";
import { FilesPage, retentionReason } from "./files";
import type { EphemeralFileResponse } from "@/api/types";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

const now = Date.now();

const streamedFile = {
  token: "tok-stream",
  releaseId: "rel-stream",
  workId: "work-1",
  title: "Asterion.Station.S02E06.2160p-ORBIT",
  fileName: "Asterion.Station.S02E06.mkv",
  state: "ready",
  container: "mkv",
  client: "jellyfin",
  requestedById: "user-1",
  requestedByName: "Mara Voss",
  sizeBytes: 4_100_000_000,
  bytesServed: 1_000_000,
  chunksQueried: 4,
  totalChunks: 10,
  estimatedStreamedPercent: 40,
  cachedChunks: 4,
  storageBytes: 400_000,
  retentionPriority: "normal",
  preDownloadJobId: null,
  preDownloadKind: null,
  preDownloadReason: null,
  preDownloadState: null,
  preDownloadedBytes: 0,
  preDownloadTotalBytes: 0,
  preDownloadPercent: 0,
  localCacheReady: false,
  isStreaming: true,
  createdAt: ago(30 * 60_000),
  lastAccessedAt: ago(60_000),
  purgeAt: later(22 * 3_600_000),
};

const preDownloadFile = {
  ...streamedFile,
  token: "tok-predl",
  releaseId: "rel-predl",
  title: "Asterion.Station.S02E07.2160p-ORBIT",
  fileName: "Asterion.Station.S02E07.mkv",
  retentionPriority: "background",
  preDownloadJobId: "job-1",
  preDownloadKind: "nextEpisode",
  preDownloadReason: "Watch progress reached 75%",
  preDownloadState: "downloading",
  preDownloadedBytes: 780_000_000,
  preDownloadTotalBytes: 1_000_000_000,
  preDownloadPercent: 78,
  isStreaming: false,
};

const cachedRelease = {
  releaseId: "rel-stream",
  workId: "work-1",
  title: "Asterion.Station.S02E06.2160p-ORBIT",
  indexer: "NZBGeek",
  releaseSizeBytes: 4_100_000_000,
  nzbSizeBytes: 830_000,
  fileCount: 62,
  segmentCount: 5_400,
  hitCount: 7,
  cachedAt: ago(17 * 24 * 3_600_000),
  lastAccessedAt: ago(3_600_000),
};

const storageSnapshot = {
  disk: { totalBytes: 2_000_000_000_000, freeBytes: 420_000_000_000, minimumFreeBytes: 1_073_741_824 },
  segmentCache: { entries: 1_204, usedBytes: 326_000_000, capacityBytes: 536_870_912 },
  preDownload: { path: "/data/cache/pre-download", fileCount: 1, usedBytes: 780_000_000 },
  nzbLibrary: { entries: 386, maxEntries: 2_000, usedBytes: 130_000_000, budgetBytes: 1_073_741_824 },
  ephemeral: { files: 2, usedBytes: 8_200_000_000, budgetBytes: 107_374_182_400 },
};

let fileRows: unknown[];
let releaseRows: unknown[];
let purged: string[];
let removed: string[];

function installFetch() {
  fileRows = [streamedFile, preDownloadFile];
  releaseRows = [cachedRelease];
  purged = [];
  removed = [];
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const purgeMatch = url.match(/\/ephemeral-files\/([^/]+)\/purge/);
    const removeMatch = url.match(/\/library\/releases\/([^/]+)$/);
    if (purgeMatch && method === "POST") {
      purged.push(decodeURIComponent(purgeMatch[1]));
      fileRows = [streamedFile];
      return response(undefined, 204);
    }
    if (removeMatch && method === "DELETE") {
      removed.push(decodeURIComponent(removeMatch[1]));
      releaseRows = [];
      return response(undefined, 204);
    }
    if (url.includes("/storage") && method === "GET") return response(storageSnapshot);
    if (url.includes("/ephemeral-files") && method === "GET") return response(fileRows);
    if (url.includes("/library/releases") && method === "GET") return response(releaseRows);
    return response({ error: { code: "not_found", message: "no" } }, 404);
  }));
}

describe("Files page", () => {
  beforeEach(() => {
    setSession({ username: "admin", role: "admin", expiresAt: later(3_600_000) });
    installFetch();
  });

  afterEach(() => vi.restoreAllMocks());

  it("shows storage occupancy for disk, caches, pre-downloads, and the NZB library", async () => {
    renderWithProviders(<FilesPage />);

    const strip = await screen.findByRole("region", { name: "Storage overview" });
    expect(await within(strip).findByText("391 GB")).toBeInTheDocument();
    expect(within(strip).getByText(/of 1\.8 TB/)).toBeInTheDocument();
    expect(within(strip).getByRole("group", { name: /Segment cache/ })).toBeInTheDocument();
    expect(within(strip).getByText(/1[.,]204 segments in memory/)).toBeInTheDocument();
    expect(within(strip).getByText(/386 \/ 2000 entries/)).toBeInTheDocument();
    expect(within(strip).getByText(/1 file on disk/)).toBeInTheDocument();
  });

  it("lists held files with since, until, and the reason they exist", async () => {
    renderWithProviders(<FilesPage />);

    expect(await screen.findByText("Stream · Mara Voss")).toBeInTheDocument();
    expect(screen.getByText("Pre-download · next episode")).toBeInTheDocument();
    expect(screen.getByText("Watch progress reached 75%")).toBeInTheDocument();
    expect(screen.getByText("streaming")).toBeInTheDocument();
    expect(screen.getByText("78% on disk")).toBeInTheDocument();
    expect(screen.getAllByText(/since \d+m ago|since \d+h ago/).length).toBe(2);
    expect(screen.getAllByText(/until in \d+h/).length).toBe(2);
  });

  it("blocks purging a file that is actively streaming but allows idle purges", async () => {
    const user = userEvent.setup();
    renderWithProviders(<FilesPage />);

    const streamingPurge = await screen.findByRole("button", { name: /purge ephemeral file Asterion\.Station\.S02E06/i });
    expect(streamingPurge).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /purge ephemeral file Asterion\.Station\.S02E07/i }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(purged).toEqual(["tok-predl"]));
  });

  it("lists the NZB library with sizes, structure, and usage", async () => {
    renderWithProviders(<FilesPage />);

    expect(await screen.findByText("NZBGeek")).toBeInTheDocument();
    expect(screen.getByText(/62 files · 5[.,]400 chunks/)).toBeInTheDocument();
    expect(screen.getByText(/7 hits/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /download NZB for/i })).toHaveAttribute("href", expect.stringContaining("/library/releases/rel-stream/download"));
  });

  it("deletes a cached NZB after confirmation", async () => {
    const user = userEvent.setup();
    renderWithProviders(<FilesPage />);

    await user.click(await screen.findByRole("button", { name: /purge cached NZB/i }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(removed).toEqual(["rel-stream"]));
  });

  it("derives the retention reason from pre-download metadata", () => {
    expect(retentionReason(streamedFile as unknown as EphemeralFileResponse).label).toBe("Stream · Mara Voss");
    expect(retentionReason(preDownloadFile as unknown as EphemeralFileResponse)).toMatchObject({
      label: "Pre-download · next episode",
      detail: "Watch progress reached 75%",
      preDownload: true,
    });
    expect(retentionReason({
      ...streamedFile,
      preDownloadKind: "currentFile",
      preDownloadReason: "Playback passed 10 seconds",
    } as unknown as EphemeralFileResponse).label).toBe("Pre-download · current file");
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
