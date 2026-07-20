import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import { setSession } from "@/api/token";
import { ProfilesPage } from "./profiles";

const defaultProfile = {
  id: "default",
  name: "Standard",
  isDefault: true,
  preferredResolutions: ["1080p", "2160p"],
  preferredSources: ["WEB-DL"],
  preferredCodecs: ["x265"],
  preferredLanguages: ["en"],
  groupAllowList: [],
  groupDenyList: [],
  resolutionWeight: 100,
  sourceWeight: 80,
  codecWeight: 40,
  languageWeight: 60,
  audioWeight: 30,
  sizeWeight: 20,
  properRepackBonus: 20,
  recencyBonus: 10,
  grabsBonus: 10,
  groupAllowBonus: 50,
  groupDenyPenalty: 100000,
  minBytesPerMinute: 3000000,
  maxBytesPerMinute: 1500000000,
  sizeBands: {},
};

// The debug/search response the mock returns — two releases in a fixed ranked order that
// the live preview must render top-to-bottom (BRIEF §9.1 live preview).
const debugResponse = {
  indexers: [{ indexerId: "1", indexerName: "mock", status: "succeeded", itemCount: 2, elapsedMs: 5 }],
  results: [
    {
      workId: "tmdb-movie-1",
      mediaType: "movie",
      title: "Example Movie",
      year: 2021,
      releases: [
        { releaseId: "top", title: "Example.2021.2160p.BluRay.x265", indexer: "mock", sizeBytes: 1, ageDays: 1, grabs: 5, score: 900, rejected: false, health: "unknown", parsed: { mediaType: "movie" }, scoreBreakdown: [], rejections: [] },
        { releaseId: "next", title: "Example.2021.1080p.WEB-DL.x265", indexer: "mock", sizeBytes: 1, ageDays: 1, grabs: 5, score: 500, rejected: false, health: "unknown", parsed: { mediaType: "movie" }, scoreBreakdown: [], rejections: [] },
      ],
    },
  ],
};

let debugBodies: Array<Record<string, unknown>> = [];
let importPreviewBodies: Array<Record<string, unknown>> = [];
let importBodies: Array<Record<string, unknown>> = [];

function installFetch() {
  debugBodies = [];
  importPreviewBodies = [];
  importBodies = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/config/profiles") && method === "GET") {
      return jsonResponse(200, [defaultProfile]);
    }
    if (url.includes("/debug/search") && method === "POST") {
      debugBodies.push(init?.body ? JSON.parse(init.body as string) : {});
      return jsonResponse(200, debugResponse);
    }
    if (url.includes("/config/profiles/import/preview") && method === "POST") {
      importPreviewBodies.push(init?.body ? JSON.parse(init.body as string) : {});
      return jsonResponse(200, {
        source: "radarr",
        instanceName: "Cinema Radarr",
        version: "5.2.0",
        profiles: [
          {
            externalId: 7,
            name: "Remux + WEB",
            suggestedAppliesTo: "movies",
            qualityCount: 8,
            scoredFormatCount: 3,
            supportedConditionCount: 5,
            unsupportedConditionCount: 0,
            profile: {
              ...defaultProfile,
              id: undefined,
              name: "Remux + WEB",
              isDefault: false,
              appliesTo: "movies",
              importedFrom: "radarr",
              importedProfileId: 7,
              minimumCustomFormatScore: 0,
              customFormats: [
                { name: "HDR10+ Boost", score: 500, conditions: [] },
                { name: "Avoid LQ", score: -10000, conditions: [] },
                { name: "TrueHD Atmos", score: 1500, conditions: [] },
              ],
            },
          },
        ],
      });
    }
    if (url.endsWith("/config/profiles/import") && method === "POST") {
      importBodies.push(init?.body ? JSON.parse(init.body as string) : {});
      return jsonResponse(201, [
        {
          ...defaultProfile,
          id: "imported-7",
          name: "Remux + WEB",
          isDefault: false,
          appliesTo: "both",
          importedFrom: "radarr",
          importedProfileId: 7,
          customFormats: [],
        },
      ]);
    }
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

describe("ProfilesPage live preview", () => {
  beforeEach(() => {
    setSession({ username: "admin", role: "admin", expiresAt: future() });
    installFetch();
  });
  afterEach(() => vi.restoreAllMocks());

  it("marks the built-in profile read-only", async () => {
    renderWithProviders(<ProfilesPage />);
    expect(await screen.findByText(/built-in · read-only/i)).toBeInTheDocument();
  });

  it("runs a sample query through /debug/search with the draft profile in the body", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProfilesPage />);

    const queryInput = await screen.findByLabelText(/sample query/i);
    await user.type(queryInput, "Example Movie");
    await user.click(screen.getByRole("button", { name: /preview/i }));

    await waitFor(() => expect(debugBodies).toHaveLength(1));
    const body = debugBodies[0];
    expect(body.q).toBe("Example Movie");
    // The unsaved draft profile is sent inline so ranking reflects it before saving.
    expect(body.profile).toBeTruthy();
    const profile = body.profile as Record<string, unknown>;
    expect(profile.resolutionWeight).toBe(100);
    expect(Array.isArray(profile.preferredResolutions)).toBe(true);
  });

  it("sends edited draft weights to the live preview so it re-ranks with unsaved changes", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProfilesPage />);

    // The only seeded profile is the read-only built-in, so start a new (editable) draft.
    await user.click(await screen.findByRole("button", { name: "New profile" }));

    // A draft needs a name before it validates (buildDraft parses the whole form).
    await user.type(screen.getByLabelText("Name", { exact: true }), "My profile");

    // Bump the resolution weight — this is the live-preview reorder lever (BRIEF §9.1).
    const resolutionWeight = screen.getByLabelText("Resolution", { exact: true });
    await user.clear(resolutionWeight);
    await user.type(resolutionWeight, "250");

    await user.type(screen.getByLabelText(/sample query/i), "Example Movie");
    await user.click(screen.getByRole("button", { name: /preview/i }));

    await waitFor(() => expect(debugBodies).toHaveLength(1));
    const profile = debugBodies[0].profile as Record<string, unknown>;
    // The edited (unsaved) weight rides along in the request that drives the re-rank.
    expect(profile.resolutionWeight).toBe(250);
  });

  it("renders preview releases in the ranked order returned by the server", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProfilesPage />);

    const queryInput = await screen.findByLabelText(/sample query/i);
    await user.type(queryInput, "Example Movie");
    await user.click(screen.getByRole("button", { name: /preview/i }));

    const list = await screen.findByRole("list", { name: /ranked releases/i });
    const items = within(list).getAllByRole("listitem");
    // First rendered release is the higher-scored one; order is preserved from the response.
    expect(within(items[0]).getByText(/2160p\.BluRay/)).toBeInTheDocument();
    expect(within(items[1]).getByText(/1080p\.WEB-DL/)).toBeInTheDocument();
    expect(within(items[0]).getByText(/score 900/)).toBeInTheDocument();
  });

  it("previews Arr profiles and imports them with the selected media scope", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProfilesPage />);

    await user.click(await screen.findByRole("button", { name: /import from arr/i }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText(/api key/i), "radarr-secret");
    await user.click(within(dialog).getByRole("button", { name: /connect & inspect/i }));

    expect(await within(dialog).findByText("Cinema Radarr")).toBeInTheDocument();
    expect(within(dialog).getByText("Remux + WEB")).toBeInTheDocument();
    expect(within(dialog).getByText("3 scored formats")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Both" }));
    await user.click(within(dialog).getByRole("button", { name: "Import 1" }));

    await waitFor(() => expect(importBodies).toHaveLength(1));
    expect(importPreviewBodies[0]).toMatchObject({
      source: "radarr",
      apiKey: "radarr-secret",
    });
    expect(importBodies[0]).toMatchObject({
      source: "radarr",
      profiles: [{ externalId: 7, appliesTo: "both" }],
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

function future(): string {
  return new Date(Date.now() + 3_600_000).toISOString();
}
