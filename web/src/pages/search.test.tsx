import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { focusManager, onlineManager } from "@tanstack/react-query";
import { renderWithProviders } from "@/test/render";
import { setSession } from "@/api/token";
import { queryKeys } from "@/api/queries";
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

const discoveryResponse = {
  results: [
    {
      workId: "tmdb-movie-693134",
      mediaType: "movie",
      title: "Dune: Part Two",
      year: 2024,
      tmdbId: 693134,
      overview: "Paul Atreides unites with Chani and the Fremen.",
      posterUrl: "https://image.example/dune-part-two.jpg",
      runtimeMinutes: 167,
      releases: [
        {
          releaseId: "dune-release",
          title: "Dune.Part.Two.2024.2160p.BluRay.x265-GRP",
          indexer: "mock",
          sizeBytes: 20_000_000_000,
          score: 910,
          health: "unknown",
          quality: { resolution: "2160p", source: "BluRay", codec: "x265", hdr: "HDR10" },
        },
        {
          releaseId: "dune-release-1080p",
          title: "Dune.Part.Two.2024.1080p.WEB-DL.x265-GRP",
          indexer: "mock",
          sizeBytes: 8_000_000_000,
          ageDays: 4,
          grabs: 61,
          score: 760,
          health: "unknown",
          quality: { resolution: "1080p", source: "WEB-DL", codec: "x265" },
        },
      ],
    },
  ],
};

const tvSearchResponse = {
  results: [
    {
      workId: "tmdb-tv-90228",
      mediaType: "series",
      title: "Dune: Prophecy",
      year: 2024,
      tmdbId: 90228,
      overview: "Ten thousand years before Paul Atreides, two sisters build a dynasty.",
      posterUrl: "https://image.example/dune-prophecy.jpg",
      runtimeMinutes: 60,
    },
  ],
};

const tvSeriesDetails = {
  series: {
    ...tvSearchResponse.results[0],
    seasonCount: 1,
    episodeCount: 2,
  },
  seasons: [
    {
      workId: "tmdb-tv-90228-s01",
      mediaType: "season",
      tmdbId: 90228,
      seasonNumber: 1,
      title: "Season 1",
      airDate: "2024-11-17",
      episodeCount: 2,
    },
  ],
};

const tvSeasonDetails = {
  series: tvSeriesDetails.series,
  season: tvSeriesDetails.seasons[0],
  indexers: [{ indexerId: "1", indexerName: "mock", status: "succeeded", itemCount: 1, elapsedMs: 8 }],
  episodes: [
    {
      workId: "tmdb-tv-90228-s01e01",
      mediaType: "episode",
      tmdbId: 90228,
      seriesTitle: "Dune: Prophecy",
      seasonNumber: 1,
      episodeNumber: 1,
      title: "The Hidden Hand",
      airDate: "2024-11-17",
      runtimeMinutes: 66,
      releases: [],
    },
    {
      workId: "tmdb-tv-90228-s01e04",
      mediaType: "episode",
      tmdbId: 90228,
      seriesTitle: "Dune: Prophecy",
      seasonNumber: 1,
      episodeNumber: 4,
      title: "Twice Born",
      airDate: "2024-12-08",
      runtimeMinutes: 63,
      releases: [
        {
          releaseId: "prophecy-release",
          title: "Dune.Prophecy.S01E04.1080p.WEB-DL.x265-GRP",
          indexer: "mock",
          sizeBytes: 3_000_000_000,
          score: 700,
          health: "unknown",
          quality: { resolution: "1080p", source: "WEB-DL", codec: "x265" },
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

function installFetch(hasTmdbApiKey = true) {
  let seasonFailure = false;
  let seriesFailure = false;
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/config/general") && method === "GET")
      return jsonResponse(200, { hasTmdbApiKey });
    if (url.includes("/debug/search") && method === "POST") return jsonResponse(200, debugResponse);
    if (url.includes("/tv/search?") && method === "GET") return jsonResponse(200, tvSearchResponse);
    if (url.includes("/tv/90228/seasons/1") && method === "GET") {
      return seasonFailure
        ? jsonResponse(503, {
            error: { code: "season_unavailable", message: "Season availability is unavailable." },
          })
        : jsonResponse(200, tvSeasonDetails);
    }
    if (url.match(/\/tv\/90228(?:\?|$)/) && method === "GET") {
      return seriesFailure
        ? jsonResponse(503, {
            error: { code: "series_unavailable", message: "Series directory is unavailable." },
          })
        : jsonResponse(200, tvSeriesDetails);
    }
    if (url.includes("/search?") && method === "GET") return jsonResponse(200, discoveryResponse);
    if (url.includes("/resolve") && method === "POST") return jsonResponse(200, resolveResponse);
    return jsonResponse(404, { error: { code: "not_found", message: "no" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    setSeasonFailure(value: boolean) {
      seasonFailure = value;
    },
    setSeriesFailure(value: boolean) {
      seriesFailure = value;
    },
  };
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
  await user.click(screen.getByRole("tab", { name: /release diagnostics/i }));
  await user.type(screen.getByLabelText(/^query$/i), "Example Movie");
  await user.click(screen.getByRole("button", { name: /search/i }));
  await screen.findByText(/Example\.2021\.2160p\.BluRay/);
  return user;
}

describe("SearchPage debug playground", () => {
  beforeEach(() => {
    setSession({ username: "admin", role: "admin", expiresAt: future() });
    installFetch();
  });
  afterEach(() => {
    focusManager.setFocused(undefined);
    onlineManager.setOnline(true);
    vi.restoreAllMocks();
  });

  it("keeps both tab panels mounted so local state and results survive tab switches", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SearchPage />);

    const tablist = screen.getByRole("tablist", { name: /search mode/i });
    expect(tablist).toHaveClass("grid", "w-full", "grid-cols-2", "sm:inline-flex");
    expect(screen.getByRole("tab", { name: /semantic discovery/i })).toHaveClass(
      "min-w-0",
      "whitespace-normal",
    );

    await user.type(screen.getByLabelText(/semantic query/i), "Dune 2");
    await user.click(screen.getByRole("button", { name: /discover/i }));
    const movieDisclosure = await screen.findByRole("button", {
      name: /dune: part two, 2 releases, expand details/i,
    });
    await user.click(movieDisclosure);

    await user.click(screen.getByRole("tab", { name: /release diagnostics/i }));
    await user.type(screen.getByLabelText(/^query$/i), "Example Movie");
    await user.click(screen.getByRole("button", { name: /^search$/i }));
    await screen.findByText(/Example\.2021\.2160p\.BluRay/);
    await user.type(screen.getByLabelText(/filter releases/i), "BluRay");

    await user.click(screen.getByRole("tab", { name: /semantic discovery/i }));
    expect(screen.getByLabelText(/semantic query/i)).toHaveValue("Dune 2");
    expect(movieDisclosure).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/Dune\.Part\.Two\.2024\.2160p/)).toBeVisible();

    await user.click(screen.getByRole("tab", { name: /release diagnostics/i }));
    expect(screen.getByLabelText(/^query$/i)).toHaveValue("Example Movie");
    expect(screen.getByLabelText(/filter releases/i)).toHaveValue("BluRay");
    expect(screen.getByText(/Example\.2021\.2160p\.BluRay/)).toBeVisible();
  });

  it("keeps the discovery mutation observer alive while its tab is inactive", async () => {
    const user = userEvent.setup();
    let resolveMovie!: (response: Response) => void;
    const movieResponse = new Promise<Response>((resolve) => {
      resolveMovie = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("/config/general") && method === "GET")
        return jsonResponse(200, { hasTmdbApiKey: true });
      if (url.includes("/tv/search?") && method === "GET")
        return jsonResponse(200, { results: [] });
      if (url.includes("/search?") && method === "GET") return movieResponse;
      return jsonResponse(404, { error: { code: "not_found", message: "no" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderWithProviders(<SearchPage />);

    await user.type(screen.getByLabelText(/semantic query/i), "Dune 2");
    await user.click(screen.getByRole("button", { name: /discover/i }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/search?"))).toBe(true),
    );
    await user.click(screen.getByRole("tab", { name: /release diagnostics/i }));

    await act(async () => {
      resolveMovie(await jsonResponse(200, discoveryResponse));
      await movieResponse;
    });
    await user.click(screen.getByRole("tab", { name: /semantic discovery/i }));

    expect(await screen.findByRole("heading", { name: "Movies" })).toBeVisible();
  });

  it("does not render a false empty state when only one discovery branch succeeds", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.includes("/config/general") && method === "GET")
          return jsonResponse(200, { hasTmdbApiKey: true });
        if (url.includes("/tv/search?") && method === "GET")
          return jsonResponse(503, {
            error: { code: "tmdb_unavailable", message: "TV metadata is unavailable." },
          });
        if (url.includes("/search?") && method === "GET")
          return jsonResponse(200, { results: [] });
        return jsonResponse(404, { error: { code: "not_found", message: "no" } });
      }),
    );
    renderWithProviders(<SearchPage />);

    await user.type(screen.getByLabelText(/semantic query/i), "Unknown title");
    await user.click(screen.getByRole("button", { name: /discover/i }));

    expect(await screen.findByText("TV metadata is unavailable.")).toBeVisible();
    expect(screen.queryByText("No semantic matches")).not.toBeInTheDocument();
  });

  it("expands movie matches to reveal every release and its play action", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SearchPage />);

    await user.type(screen.getByLabelText(/semantic query/i), "Dune 2");
    await user.click(screen.getByRole("button", { name: /discover/i }));

    expect(await screen.findByRole("heading", { name: "Movies" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "TV series" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /dune: part two poster/i })).toHaveAttribute(
      "src",
      "https://image.example/dune-part-two.jpg",
    );
    expect(screen.getByRole("img", { name: /dune: prophecy poster/i })).toHaveAttribute(
      "src",
      "https://image.example/dune-prophecy.jpg",
    );
    expect(screen.queryByText(/Dune\.Part\.Two\.2024\.2160p/)).not.toBeInTheDocument();
    const disclosure = screen.getByRole("button", {
      name: /dune: part two, 2 releases, expand details/i,
    });
    await user.click(disclosure);

    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText(/Dune\.Part\.Two\.2024\.2160p/)).toBeInTheDocument();
    expect(screen.getByText(/Dune\.Part\.Two\.2024\.1080p/)).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /play preview/i })).toHaveLength(2);
  });

  it("loads a TV hierarchy lazily and keeps unavailable canonical episodes visible", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SearchPage />);

    await user.type(screen.getByLabelText(/semantic query/i), "Dune 2");
    await user.click(screen.getByRole("button", { name: /discover/i }));

    const seriesButton = await screen.findByRole("button", { name: /dune: prophecy, browse seasons/i });
    expect(screen.queryByText("Season 1")).not.toBeInTheDocument();
    await user.click(seriesButton);

    const seasonButton = await screen.findByRole("button", { name: /season 1, 2 episodes, load availability/i });
    expect(screen.queryByText("The Hidden Hand")).not.toBeInTheDocument();
    await user.click(seasonButton);

    expect(await screen.findByText("The Hidden Hand")).toBeInTheDocument();
    expect(screen.getByText("Twice Born")).toBeInTheDocument();
    expect(screen.getByText("not found")).toBeInTheDocument();
    expect(screen.getAllByText("1 available")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: /s01e04 twice born, 1 releases, expand/i }));
    expect(await screen.findByText(/Dune\.Prophecy\.S01E04/)).toBeInTheDocument();
  });

  it("does not repeat a stale season fan-out after focus or reconnect", async () => {
    const user = userEvent.setup();
    const { fetchMock } = installFetch();
    const { queryClient } = renderWithProviders(<SearchPage />);

    await user.type(screen.getByLabelText(/semantic query/i), "Dune 2");
    await user.click(screen.getByRole("button", { name: /discover/i }));
    await user.click(
      await screen.findByRole("button", { name: /dune: prophecy, browse seasons/i }),
    );
    await user.click(
      await screen.findByRole("button", { name: /season 1, 2 episodes, load availability/i }),
    );
    expect(await screen.findByText("Twice Born")).toBeVisible();

    const seasonCalls = () =>
      fetchMock.mock.calls.filter(([input]) => String(input).includes("/tv/90228/seasons/1"))
        .length;
    expect(seasonCalls()).toBe(1);
    await queryClient.invalidateQueries({
      queryKey: queryKeys.tvSeason(90228, 1),
      exact: true,
      refetchType: "none",
    });

    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
      await Promise.resolve();
    });
    expect(seasonCalls()).toBe(1);
  });

  it("keeps cached episode availability visible when a background refresh fails", async () => {
    const user = userEvent.setup();
    const controls = installFetch();
    const { queryClient } = renderWithProviders(<SearchPage />);

    await user.type(screen.getByLabelText(/semantic query/i), "Dune 2");
    await user.click(screen.getByRole("button", { name: /discover/i }));
    await user.click(
      await screen.findByRole("button", { name: /dune: prophecy, browse seasons/i }),
    );
    await user.click(
      await screen.findByRole("button", { name: /season 1, 2 episodes, load availability/i }),
    );
    expect(await screen.findByText("Twice Born")).toBeVisible();

    controls.setSeasonFailure(true);
    await queryClient.refetchQueries({
      queryKey: queryKeys.tvSeason(90228, 1),
      exact: true,
    });

    expect(await screen.findByText("Season availability is unavailable.")).toBeVisible();
    expect(screen.getByText("The Hidden Hand")).toBeVisible();
    expect(screen.getByText("Twice Born")).toBeVisible();
    expect(
      screen.getByRole("button", { name: /s01e04 twice born, 1 releases, expand/i }),
    ).toBeVisible();
  });

  it("keeps cached season directories visible when a background refresh fails", async () => {
    const user = userEvent.setup();
    const controls = installFetch();
    const { queryClient } = renderWithProviders(<SearchPage />);

    await user.type(screen.getByLabelText(/semantic query/i), "Dune 2");
    await user.click(screen.getByRole("button", { name: /discover/i }));
    await user.click(
      await screen.findByRole("button", { name: /dune: prophecy, browse seasons/i }),
    );
    expect(await screen.findByText("Season 1")).toBeVisible();

    controls.setSeriesFailure(true);
    await queryClient.refetchQueries({
      queryKey: queryKeys.tvSeries(90228),
      exact: true,
    });

    expect(await screen.findByText("Series directory is unavailable.")).toBeVisible();
    expect(screen.getByText("Season 1")).toBeVisible();
    expect(
      screen.getByRole("button", { name: /season 1, 2 episodes, load availability/i }),
    ).toBeVisible();
  });

  it("explains why semantic results are unavailable when the TMDB key is missing", async () => {
    installFetch(false);
    renderWithProviders(<SearchPage />);

    expect(await screen.findByText(/tmdb metadata is not configured/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /settings/i })).toHaveAttribute("href", "/settings");
  });

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

  it("filters the table by release name", async () => {
    const user = await runSearch();
    await user.type(screen.getByLabelText(/filter releases/i), "SAMPLE");
    // Only the matching (rejected) release survives the name filter.
    expect(screen.getByText(/Example\.2021\.SAMPLE\.720p/)).toBeInTheDocument();
    expect(screen.queryByText(/Example\.2021\.2160p\.BluRay/)).not.toBeInTheDocument();
    expect(screen.getByText(/1 shown · 2 releases · 1 rejected/)).toBeInTheDocument();
  });

  it("re-sorts by size, moving the largest release to the top of the table", async () => {
    const user = await runSearch();
    await user.click(screen.getByRole("button", { name: /^size/i }));
    const rows = screen.getAllByRole("row");
    // rows[0] is the header; the first data row is the largest (5 GiB 2160p) release.
    const firstData = rows[1];
    expect(within(firstData).getByText(/Example\.2021\.2160p\.BluRay/)).toBeInTheDocument();
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

  it("offers a one-click allow-host fix when resolve fails on an off-origin download host", async () => {
    // Resolve fails with the structured host error until the host is added to the indexer.
    const hostError = {
      error: {
        code: "nzb_host_not_allowed",
        message: "The NZB download host 'dl.indexer.example' is not allowed for indexer 'mock'.",
        host: "dl.indexer.example",
        indexerId: "ix1",
      },
    };
    let hostAllowed = false;
    const put: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.includes("/debug/search") && method === "POST") return jsonResponse(200, debugResponse);
        if (url.match(/\/config\/indexers\/ix1$/) && method === "GET")
          return jsonResponse(200, { id: "ix1", name: "mock", baseUrl: "https://indexer.example", allowedDownloadHosts: [] });
        if (url.match(/\/config\/indexers\/ix1$/) && method === "PUT") {
          put.push(JSON.parse(init!.body as string));
          hostAllowed = true;
          return jsonResponse(200, {});
        }
        if (url.includes("/resolve") && method === "POST")
          return hostAllowed ? jsonResponse(200, resolveResponse) : jsonResponse(422, hostError);
        return jsonResponse(404, { error: { code: "not_found", message: "no" } });
      }),
    );

    const user = await runSearch();
    const acceptedRow = screen.getByText(/Example\.2021\.2160p\.BluRay/).closest("tr")!;
    await user.click(within(acceptedRow).getByRole("button", { name: /resolve/i }));

    // The failure surfaces the offending host and a quick-add button.
    const fix = await screen.findByRole("button", { name: /allow .*dl\.indexer\.example.* & retry/i });
    await user.click(fix);

    // It PUT the host onto the indexer, then re-resolved successfully.
    await waitFor(() => expect(put).toHaveLength(1));
    expect(put[0].allowedDownloadHosts).toEqual(["dl.indexer.example"]);
    await waitFor(() => expect(screen.getByText("ready")).toBeInTheDocument());
  });
});

function future(): string {
  return new Date(Date.now() + 3_600_000).toISOString();
}
