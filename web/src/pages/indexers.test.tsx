import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import { setSession } from "@/api/token";
import { IndexersPage } from "./indexers";

const indexer = {
  id: "ix1",
  name: "NZBGeek",
  baseUrl: "https://api.nzbgeek.info",
  hasApiKey: true,
  categories: [2000, 5000],
  enabled: true,
  priority: 0,
};

const backupIndexer = {
  ...indexer,
  id: "ix2",
  name: "DrunkenSlug",
  baseUrl: "https://api.drunkenslug.com",
  priority: 1,
};

const testResult = {
  success: true,
  latencyMs: 123,
  categoryCount: 7,
  searchAvailable: true,
  movieSearchAvailable: true,
  tvSearchAvailable: true,
  serverVersion: "1.3",
};

let putBodies: Array<Record<string, unknown>> = [];
let orderBodies: Array<Record<string, unknown>> = [];

function installFetch() {
  putBodies = [];
  orderBodies = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/config/indexers") && method === "GET") {
      return jsonResponse(200, [indexer, backupIndexer]);
    }
    if (url.includes("/config/indexers/ix1/test") && method === "POST") {
      return jsonResponse(200, testResult);
    }
    if (url.endsWith("/config/indexers/order") && method === "PUT") {
      orderBodies.push(init?.body ? JSON.parse(init.body as string) : {});
      return jsonResponse(204, {});
    }
    if (url.includes("/config/indexers/ix1") && method === "PUT") {
      putBodies.push(init?.body ? JSON.parse(init.body as string) : {});
      return jsonResponse(200, { ...indexer, ...JSON.parse(init!.body as string) });
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

describe("IndexersPage", () => {
  beforeEach(() => {
    setSession({ username: "admin", role: "admin", expiresAt: future() });
    installFetch();
  });
  afterEach(() => vi.restoreAllMocks());

  it("lists indexers from the config API", async () => {
    renderWithProviders(<IndexersPage />);
    expect(await screen.findByText("NZBGeek")).toBeInTheDocument();
  });

  it("surfaces caps and latency after a Test", async () => {
    const user = userEvent.setup();
    renderWithProviders(<IndexersPage />);
    await screen.findByText("NZBGeek");

    const row = screen.getByText("NZBGeek").closest("li")!;
    await user.click(within(row).getByRole("button", { name: /test/i }));

    expect(await screen.findByText(/latency 123 ms/i)).toBeInTheDocument();
    expect(screen.getByText(/7 categories/i)).toBeInTheDocument();
  });

  it("toggles enable/disable via PUT (omitting the write-only api key)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<IndexersPage />);
    await screen.findByText("NZBGeek");

    await user.click(screen.getByRole("switch", { name: /disable nzbgeek/i }));

    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0].enabled).toBe(false);
    // Omit-to-keep: no plaintext key is sent when just toggling.
    expect("apiKey" in putBodies[0]).toBe(false);
  });

  it("adds an allowed download host through the edit form", async () => {
    const user = userEvent.setup();
    renderWithProviders(<IndexersPage />);
    await screen.findByText("NZBGeek");

    const row = screen.getByText("NZBGeek").closest("li")!;
    await user.click(within(row).getByRole("button", { name: /edit nzbgeek/i }));

    await user.click(await screen.findByRole("button", { name: /add host/i }));
    await user.type(screen.getByLabelText(/allowed download host 1/i), "dl.nzbgeek.info");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0].allowedDownloadHosts).toEqual(["dl.nzbgeek.info"]);
  });

  it("reorders with one atomic order request", async () => {
    const user = userEvent.setup();
    renderWithProviders(<IndexersPage />);
    await screen.findByText("NZBGeek");

    await user.click(screen.getByRole("button", { name: /move nzbgeek down/i }));

    await waitFor(() => expect(orderBodies).toEqual([{ ids: ["ix2", "ix1"] }]));
    expect(putBodies).toHaveLength(0);
  });
});

function future(): string {
  return new Date(Date.now() + 3_600_000).toISOString();
}
