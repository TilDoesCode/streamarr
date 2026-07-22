import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import { setSession } from "@/api/token";
import { EphemeralFilesPage } from "./ephemeral-files";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

function file(overrides: Record<string, unknown> = {}) {
  return {
    token: "tok-1",
    releaseId: "rel-direct",
    workId: "tmdb-movie-1",
    title: "Big Buck Bunny",
    fileName: "big-buck-bunny.mkv",
    state: "ready",
    container: "mkv",
    client: "web",
    requestedByName: "Ada",
    sizeBytes: 1_000_000,
    bytesServed: 500_000,
    chunksQueried: 4,
    totalChunks: 10,
    estimatedStreamedPercent: 40,
    cachedChunks: 4,
    storageBytes: 400_000,
    isStreaming: false,
    createdAt: new Date().toISOString(),
    lastAccessedAt: new Date().toISOString(),
    purgeAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  };
}

let purged: string[] = [];
let filesList: ReturnType<typeof file>[] = [];
let purgeStatus = 204;

function installFetch() {
  purged = [];
  filesList = [file()];
  purgeStatus = 204;
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const purgeMatch = url.match(/\/ephemeral-files\/([^/]+)\/purge/);
    if (purgeMatch && method === "POST") {
      if (purgeStatus === 204) {
        purged.push(decodeURIComponent(purgeMatch[1]));
        filesList = [];
        return jsonResponse(204, undefined);
      }
      return jsonResponse(purgeStatus, {
        error: { code: "stream_active", message: "This ephemeral file is being actively streamed and cannot be purged." },
      });
    }
    if (url.includes("/ephemeral-files") && method === "GET") return jsonResponse(200, filesList);
    return jsonResponse(404, { error: { code: "not_found", message: "no" } });
  });
  vi.stubGlobal("fetch", fetchMock);
}

function jsonResponse(status: number, body: unknown): Promise<Response> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: new Headers(body === undefined ? {} : { "content-type": "application/json" }),
    text: () => Promise.resolve(body === undefined ? "" : JSON.stringify(body)),
    clone: () => ({ json: () => Promise.resolve(body) }),
  } as unknown as Response);
}

describe("EphemeralFilesPage", () => {
  beforeEach(() => {
    setSession({ username: "admin", role: "admin", expiresAt: future() });
    installFetch();
  });
  afterEach(() => vi.restoreAllMocks());

  it("purges an idle ephemeral file after confirmation", async () => {
    const user = userEvent.setup();
    renderWithProviders(<EphemeralFilesPage />);
    await screen.findByRole("heading", { name: "Big Buck Bunny" });

    await user.click(screen.getByRole("button", { name: /purge ephemeral file/i }));
    await user.click(screen.getByRole("button", { name: /confirm/i }));

    await waitFor(() => expect(purged).toEqual(["tok-1"]));
  });

  it("disables purging for a file that is actively streaming", async () => {
    filesList = [file({ isStreaming: true })];
    renderWithProviders(<EphemeralFilesPage />);
    await screen.findByRole("heading", { name: "Big Buck Bunny" });

    expect(screen.queryByRole("button", { name: /purge ephemeral file/i })).not.toBeInTheDocument();
    const streaming = screen.getByRole("button", { name: /streaming/i });
    expect(streaming).toBeDisabled();
  });
});

function future(): string {
  return new Date(Date.now() + 3_600_000).toISOString();
}
