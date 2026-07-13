import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import { setSession } from "@/api/token";
import { PlaybackPage } from "./playback";

// No releaseId in the URL → the page waits for manual input instead of auto-resolving.
vi.mock("@tanstack/react-router", () => ({ useSearch: () => ({}) }));

const resolveResponse = {
  releaseId: "rel-direct",
  status: "ready",
  streamUrl: "http://server:8080/api/v1/stream/tok-xyz",
  container: "mkv",
  sizeBytes: 1_000_000,
  runTimeTicks: 78_000_000_000,
  mediaStreams: [{ type: "Video", codec: "h264", width: 320, height: 240 }],
  sessionTtlSeconds: 3600,
  suggestedFallbackReleaseId: null,
};

function installFetch() {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/resolve") && (init?.method ?? "GET") === "POST")
      return jsonResponse(200, resolveResponse);
    return jsonResponse(404, { error: { code: "not_found", message: "no" } });
  });
  vi.stubGlobal("fetch", fetchMock);
}

function jsonResponse(status: number, body: unknown): Promise<Response> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: new Headers({ "content-type": "application/json" }),
    text: () => Promise.resolve(JSON.stringify(body)),
    clone: () => ({ json: () => Promise.resolve(body) }),
  } as unknown as Response);
}

describe("PlaybackPage — architectural canary", () => {
  beforeEach(() => {
    setSession({ token: "admin-tok", username: "admin", role: "admin", expiresAt: future() });
    installFetch();
  });
  afterEach(() => vi.restoreAllMocks());

  it("resolves a release and plays it in a <video> authenticated via the access_token query param", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<PlaybackPage />);

    await user.type(screen.getByLabelText(/release id/i), "rel-direct");
    await user.click(screen.getByRole("button", { name: /resolve & load/i }));

    // A <video> element points at a same-origin stream path carrying the bearer token —
    // proving playback works with Jellyfin absent (BRIEF §3.1 rule 4).
    const video = await waitFor(() => {
      const el = container.querySelector("video");
      expect(el).not.toBeNull();
      return el as HTMLVideoElement;
    });
    expect(video.getAttribute("src")).toBe("/api/v1/stream/tok-xyz?access_token=admin-tok");

    // instrumentation is present (BRIEF §9.1.6)
    expect(screen.getByText(/time to first frame/i)).toBeInTheDocument();
    expect(screen.getByText(/last seek latency/i)).toBeInTheDocument();
  });
});

function future(): string {
  return new Date(Date.now() + 3_600_000).toISOString();
}
