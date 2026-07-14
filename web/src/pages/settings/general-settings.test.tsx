import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import { setSession } from "@/api/token";
import { GeneralSettings } from "./general-settings";

const config = {
  tmdbApiKey: "••••••••",
  hasTmdbApiKey: true,
  sessionTtlSeconds: 3600,
  searchCacheTtlSeconds: 60,
  segmentCacheSizeMb: 512,
  connectionBudget: 20,
};

let putBodies: unknown[] = [];

function installFetch() {
  putBodies = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/config/general") && method === "GET") {
      return jsonResponse(200, config);
    }
    if (url.includes("/config/general") && method === "PUT") {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      putBodies.push(body);
      return jsonResponse(200, { ...config, ...body });
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

describe("GeneralSettings", () => {
  beforeEach(() => {
    setSession({ username: "admin", role: "admin", expiresAt: future() });
    installFetch();
  });
  afterEach(() => vi.restoreAllMocks());

  it("loads and populates the form from the config API", async () => {
    renderWithProviders(<GeneralSettings />);
    const budget = await screen.findByLabelText(/NNTP connection budget/i);
    expect(budget).toHaveValue(20);
    // Write-only TMDB key: field is blank with the mask as placeholder.
    const tmdb = screen.getByLabelText(/TMDB API key/i) as HTMLInputElement;
    expect(tmdb.value).toBe("");
    expect(tmdb.placeholder).toBe("••••••••");
  });

  it("blocks save with a validation error when the budget is below 1 (mirrors server)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<GeneralSettings />);
    const budget = await screen.findByLabelText(/NNTP connection budget/i);

    await user.clear(budget);
    await user.type(budget, "0");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    expect(await screen.findByText(/must be at least 1/i)).toBeInTheDocument();
    expect(putBodies).toHaveLength(0);
  });

  it("omits the TMDB key on save when left blank (omit-to-keep)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<GeneralSettings />);
    const ttl = await screen.findByLabelText(/Session TTL/i);

    await user.clear(ttl);
    await user.type(ttl, "7200");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(putBodies).toHaveLength(1));
    const body = putBodies[0] as Record<string, unknown>;
    expect(body.sessionTtlSeconds).toBe(7200);
    expect("tmdbApiKey" in body).toBe(false);
  });

  it("sends the TMDB key only when the operator types one", async () => {
    const user = userEvent.setup();
    renderWithProviders(<GeneralSettings />);
    const tmdb = await screen.findByLabelText(/TMDB API key/i);

    await user.type(tmdb, "new-key");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect((putBodies[0] as Record<string, unknown>).tmdbApiKey).toBe("new-key");
  });
});

function future(): string {
  return new Date(Date.now() + 3_600_000).toISOString();
}
