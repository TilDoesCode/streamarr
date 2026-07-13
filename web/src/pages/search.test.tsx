import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import { setSession } from "@/api/token";
import { SearchPage } from "./search";

// The debug playground renders a <Link> to /playback after a resolve; stub it to a plain
// anchor so the page renders without a full router in the test.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to?: string }) => (
    <a href={typeof to === "string" ? to : "#"}>{children}</a>
  ),
}));

const debugResponse = {
  indexers: [{ indexerId: "1", indexerName: "mock", status: "succeeded", itemCount: 2, elapsedMs: 7 }],
  results: [
    {
      workId: "tmdb-movie-1",
      mediaType: "movie",
      title: "Example Movie",
      year: 2021,
      releases: [
        {
          releaseId: "accepted-1",
          title: "Example.2021.2160p.BluRay.x265-GRP",
          indexer: "mock",
          sizeBytes: 5_368_709_120,
          ageDays: 3,
          grabs: 42,
          score: 900,
          rejected: false,
          health: "unknown",
          parsed: { mediaType: "movie", resolution: "2160p", source: "BluRay", videoCodec: "x265", releaseGroup: "GRP" },
          scoreBreakdown: [
            { rule: "resolution: 2160p", points: 100 },
            { rule: "source: BluRay", points: 80 },
          ],
          rejections: [],
        },
        {
          releaseId: "rejected-1",
          title: "Example.2021.SAMPLE.720p",
          indexer: "mock",
          sizeBytes: 1_048_576,
          ageDays: 1,
          grabs: 0,
          score: 0,
          rejected: true,
          health: "unknown",
          parsed: { mediaType: "movie", resolution: "720p" },
          scoreBreakdown: [],
          rejections: [{ code: "sample", message: "Release looks like a sample clip, not the full film." }],
        },
      ],
    },
  ],
};

const resolveResponse = {
  releaseId: "accepted-1",
  status: "ready",
  streamUrl: "http://server/api/v1/stream/tok-xyz",
  container: "mkv",
  sizeBytes: 5_368_709_120,
  runTimeTicks: 78_000_000_000,
  mediaStreams: [
    { type: "Video", codec: "hevc", width: 3840, height: 2160 },
    { type: "Audio", codec: "eac3", channels: 6, language: "eng" },
  ],
  sessionTtlSeconds: 3600,
  suggestedFallbackReleaseId: null,
};

function installFetch() {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/debug/search") && method === "POST") return jsonResponse(200, debugResponse);
    if (url.includes("/resolve") && method === "POST") return jsonResponse(200, resolveResponse);
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

async function runSearch() {
  const user = userEvent.setup();
  renderWithProviders(<SearchPage />);
  await user.type(screen.getByLabelText(/^query$/i), "Example Movie");
  await user.click(screen.getByRole("button", { name: /search/i }));
  await screen.findByText(/Example\.2021\.2160p\.BluRay/);
  return user;
}

describe("SearchPage debug playground", () => {
  beforeEach(() => {
    setSession({ token: "t", username: "admin", role: "admin", expiresAt: future() });
    installFetch();
  });
  afterEach(() => vi.restoreAllMocks());

  it("lists every release including rejected ones with a plain-language reason", async () => {
    await runSearch();
    expect(screen.getByText(/Example\.2021\.SAMPLE\.720p/)).toBeInTheDocument();
    expect(screen.getByText(/2 releases · 1 rejected/)).toBeInTheDocument();
  });

  it("filters out rejected releases when the toggle is unchecked", async () => {
    const user = await runSearch();
    await user.click(screen.getByLabelText(/show rejected/i));
    expect(screen.queryByText(/Example\.2021\.SAMPLE\.720p/)).not.toBeInTheDocument();
    expect(screen.getByText(/Example\.2021\.2160p\.BluRay/)).toBeInTheDocument();
  });

  it("expands a row to reveal the per-rule score breakdown and rejection reasons", async () => {
    const user = await runSearch();
    // expand the rejected release
    const rejectedName = screen.getByText(/Example\.2021\.SAMPLE\.720p/);
    const row = rejectedName.closest("tr")!;
    await user.click(within(row).getByRole("button", { name: /expand/i }));
    expect(await screen.findByText(/looks like a sample clip/i)).toBeInTheDocument();
  });

  it("resolves a release and shows the health outcome and pre-probed media info", async () => {
    const user = await runSearch();
    const acceptedRow = screen.getByText(/Example\.2021\.2160p\.BluRay/).closest("tr")!;
    await user.click(within(acceptedRow).getByRole("button", { name: /resolve/i }));

    // health status + media streams from POST /resolve
    await waitFor(() => expect(screen.getByLabelText(/media streams/i)).toBeInTheDocument());
    expect(screen.getByText("ready")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /play preview/i })).toBeInTheDocument();
  });
});

function future(): string {
  return new Date(Date.now() + 3_600_000).toISOString();
}
