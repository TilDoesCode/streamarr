import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import { setSession } from "@/api/token";
import { ProfilesPage } from "./profiles";
import { defaultBadge } from "./profile-defaults";

const base = {
  preferredSources: [],
  preferredCodecs: [],
  preferredLanguages: [],
  groupAllowList: [],
  groupDenyList: [],
  sizeBands: {},
};
const profiles = [
  { ...base, id: "default", name: "Standard", isDefault: true, appliesTo: "both", preferredResolutions: ["1080p", "2160p"] },
  { ...base, id: "saver", name: "Spart Bandbreite", appliesTo: "both", preferredResolutions: ["720p", "1080p"] },
  { ...base, id: "shows4k", name: "Serien 4K", appliesTo: "shows", preferredResolutions: ["2160p"] },
];

let defaults: Record<string, unknown>;
let puts: Array<Record<string, unknown>> = [];

function effective(id: string, scope: "movie" | "series") {
  const p = profiles.find((x) => x.id === id) ?? profiles[0];
  const fits = p.appliesTo === "both" || (scope === "movie" ? p.appliesTo === "movies" : p.appliesTo === "shows");
  const used = fits ? p : profiles[0];
  return { id: used.id, name: used.name, source: "server" };
}

function respond(status: number, body: unknown): Promise<Response> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: new Headers({ "content-type": "application/json" }),
    text: () => Promise.resolve(JSON.stringify(body)),
    clone: () => ({ json: () => Promise.resolve(body) }),
  } as unknown as Response);
}

function install() {
  puts = [];
  defaults = {
    defaultProfileId: "default",
    movieProfileId: null,
    seriesProfileId: null,
    viewersMayChoose: true,
    effective: { movie: effective("default", "movie"), series: effective("default", "series") },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("/config/profile-defaults") && method === "PUT") {
        const body = JSON.parse(init!.body as string);
        puts.push(body);
        const series = (body.seriesProfileId ?? body.defaultProfileId) as string;
        const movie = (body.movieProfileId ?? body.defaultProfileId) as string;
        defaults = { ...body, effective: { movie: effective(movie, "movie"), series: effective(series, "series") } };
        return respond(200, defaults);
      }
      if (url.includes("/config/profile-defaults")) return respond(200, defaults);
      if (url.includes("/config/profiles") && method === "GET") return respond(200, profiles);
      return respond(404, { error: { code: "not_found", message: "no" } });
    }),
  );
}

describe("Default ranking profile", () => {
  beforeEach(() => {
    setSession({ username: "admin", role: "admin", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    install();
  });
  afterEach(() => vi.restoreAllMocks());

  it("marks the server default in the list and saves a new default", async () => {
    renderWithProviders(<ProfilesPage />);
    const list = await screen.findByRole("list", { name: "Quality profiles" });
    await waitFor(() => expect(within(list).getByText("Default")).toBeInTheDocument());
    expect(within(within(list).getAllByRole("listitem")[0]).getByText("Default")).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText("Default profile"), "saver");
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toMatchObject({ defaultProfileId: "saver", movieProfileId: null, seriesProfileId: null, viewersMayChoose: true });
    await waitFor(() => expect(within(within(list).getAllByRole("listitem")[1]).getByText("Default")).toBeInTheDocument());
    expect(screen.getByTestId("effective-defaults")).toHaveTextContent("Movies rank with Spart Bandbreite");
  });

  it("offers only matching profiles per media type and badges a series override", async () => {
    renderWithProviders(<ProfilesPage />);
    const movies = await screen.findByLabelText("Movies");
    expect(within(movies).queryByText("Serien 4K")).toBeNull();
    const series = screen.getByLabelText("Series");
    expect(within(series).getByText("Serien 4K")).toBeInTheDocument();

    await userEvent.selectOptions(series, "shows4k");
    await waitFor(() => expect(puts.at(-1)).toMatchObject({ seriesProfileId: "shows4k", defaultProfileId: "default" }));
    const list = screen.getByRole("list", { name: "Quality profiles" });
    await waitFor(() => expect(within(list).getByText("Series default")).toBeInTheDocument());
    expect(within(list).getByText("Movies default")).toBeInTheDocument();
  });

  it("toggles whether viewers may choose", async () => {
    renderWithProviders(<ProfilesPage />);
    const toggle = await screen.findByRole("switch", { name: "Viewers may choose a profile" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await userEvent.click(toggle);
    await waitFor(() => expect(puts.at(-1)).toMatchObject({ viewersMayChoose: false }));
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
  });

  it("names the badge per media type", () => {
    const d = { defaultProfileId: "a", viewersMayChoose: true, effective: { movie: { id: "a", name: "A", source: "server" }, series: { id: "b", name: "B", source: "server" } } };
    expect(defaultBadge(d, "a")).toBe("Movies default");
    expect(defaultBadge(d, "b")).toBe("Series default");
    expect(defaultBadge(d, "c")).toBeNull();
    expect(defaultBadge({ ...d, effective: { ...d.effective, series: d.effective.movie } }, "a")).toBe("Default");
  });
});
