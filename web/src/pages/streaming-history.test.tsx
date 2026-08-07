import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import { setSession } from "@/api/token";
import { StreamingHistoryPage } from "./streaming-history";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

const now = Date.now();

const playbackEvent = {
  id: 1,
  releaseId: "rel-direct",
  workId: "tmdb-movie-1",
  event: "stop",
  positionTicks: 12_000_000,
  source: "jellyfin",
  playbackSessionId: "jf-play-1",
  externalUserId: "jf-user-1",
  externalUserName: "Mara Voss",
  deviceName: "Shield TV Pro",
  receivedAt: new Date(now - 60_000).toISOString(),
};

const correlatedStreamRecord = {
  token: "tok-1",
  releaseId: "rel-direct",
  workId: "tmdb-movie-1",
  title: "Example",
  container: "mkv",
  sizeBytes: 1_000,
  bytesServed: 1_000,
  nntpCommandsTotal: 12,
  client: "jellyfin",
  requestedById: "jf-user-1",
  requestedByName: "Mara Voss",
  createdAt: new Date(now - 90_000).toISOString(),
  closedAt: new Date(now - 60_000).toISOString(),
  finalState: "closed",
  closeReason: null,
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

function installFetch(streamRecords: unknown[]) {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/library/releases")) return response([]);
    if (url.includes("/streams")) return response(streamRecords);
    if (url.includes("/events")) return response([playbackEvent]);
    return response([]);
  }));
}

describe("StreamingHistoryPage", () => {
  beforeEach(() => {
    setSession({ username: "admin", role: "admin", expiresAt: new Date(now + 60 * 60_000).toISOString() });
  });
  afterEach(() => vi.restoreAllMocks());

  it("links a playback visit to its correlated stream console when one is retained", async () => {
    installFetch([correlatedStreamRecord]);
    renderWithProviders(<StreamingHistoryPage />);

    await screen.findByText("rel-direct");
    expect(screen.getByRole("link", { name: /stream console/i })).toHaveAttribute(
      "href",
      "/sessions/$sessionToken",
    );
  });

  it("omits the cross-link when no retained stream record correlates", async () => {
    installFetch([]);
    renderWithProviders(<StreamingHistoryPage />);

    await screen.findByText("rel-direct");
    expect(screen.queryByRole("link", { name: /stream console/i })).not.toBeInTheDocument();
  });
});
