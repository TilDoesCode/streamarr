import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import { renderWithProviders } from "@/test/render";
import { setSession } from "@/api/token";
import { queryKeys } from "@/api/queries";
import { PlaybackPage } from "./playback";

let routeSearch: { releaseId?: string; workId?: string } = {};
vi.mock("@tanstack/react-router", () => ({ useSearch: () => routeSearch }));

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
    routeSearch = {};
    setSession({ username: "admin", role: "admin", expiresAt: future() });
    installFetch();
  });
  afterEach(() => vi.restoreAllMocks());

  it("resolves a release and plays it using only the session capability URL", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<PlaybackPage />);

    await user.type(screen.getByLabelText(/release id/i), "rel-direct");
    await user.click(screen.getByRole("button", { name: /resolve & load/i }));

    // The URL is same-origin and contains only the session capability. The administrator JWT
    // must never be copied to browser media URLs.
    const video = await waitFor(() => {
      const el = container.querySelector("video");
      expect(el).not.toBeNull();
      return el as HTMLVideoElement;
    });
    expect(video.getAttribute("src")).toBe("/api/v1/stream/tok-xyz");
    expect(video.getAttribute("src")).not.toContain("admin-tok");

    // instrumentation is present (BRIEF §9.1.6)
    expect(screen.getByText(/time to first frame/i)).toBeInTheDocument();
    expect(screen.getByText(/last seek latency/i)).toBeInTheDocument();
  });

  it("reuses Search's resolved session without posting a second resolve", async () => {
    routeSearch = { releaseId: "rel-direct", workId: "tmdb-tv-1-s01e02" };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData(
      queryKeys.resolvedRelease("rel-direct", "tmdb-tv-1-s01e02"),
      resolveResponse,
    );

    const { container } = renderWithProviders(<PlaybackPage />, { queryClient });

    await waitFor(() => expect(container.querySelector("video")).not.toBeNull());
    const resolveCalls = vi
      .mocked(fetch)
      .mock.calls.filter(([input, init]) =>
        String(input).includes("/resolve") && (init?.method ?? "GET") === "POST",
      );
    expect(resolveCalls).toHaveLength(0);
  });
});

function future(): string {
  return new Date(Date.now() + 3_600_000).toISOString();
}
