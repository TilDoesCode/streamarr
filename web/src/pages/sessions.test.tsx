import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import { setSession } from "@/api/token";
import { SessionsPage } from "./sessions";

const session = {
  token: "tok-1",
  releaseId: "rel-direct",
  workId: "tmdb-movie-1",
  state: "ready",
  container: "mkv",
  sizeBytes: 1_000_000,
  bytesServed: 500_000,
  nntpConnectionsInFlight: 3,
  nntpCommandsTotal: 120,
  client: "web",
  createdAt: new Date().toISOString(),
  lastAccessedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

let closed: string[] = [];
let sessionsList = [session];

function installFetch() {
  closed = [];
  sessionsList = [session];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const closeMatch = url.match(/\/sessions\/([^/]+)\/close/);
    if (closeMatch && method === "POST") {
      closed.push(decodeURIComponent(closeMatch[1]));
      sessionsList = [];
      return jsonResponse(204, undefined);
    }
    if (url.includes("/sessions") && method === "GET") return jsonResponse(200, sessionsList);
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

describe("SessionsPage", () => {
  beforeEach(() => {
    setSession({ token: "t", username: "admin", role: "admin", expiresAt: future() });
    installFetch();
  });
  afterEach(() => vi.restoreAllMocks());

  it("lists live sessions with source, bytes served and NNTP connections", async () => {
    renderWithProviders(<SessionsPage />);
    const row = (await screen.findByText("rel-direct")).closest("tr")!;
    expect(within(row).getByText("web")).toBeInTheDocument();
    expect(within(row).getByText(/489 KB|488 KB|500 KB/)).toBeInTheDocument(); // bytes served
    expect(within(row).getByText("3")).toBeInTheDocument(); // nntp conns in flight
  });

  it("force-closes a session after confirmation", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SessionsPage />);
    await screen.findByText("rel-direct");

    await user.click(screen.getByRole("button", { name: /force-close/i }));
    await user.click(screen.getByRole("button", { name: /confirm/i }));

    await waitFor(() => expect(closed).toEqual(["tok-1"]));
  });
});

function future(): string {
  return new Date(Date.now() + 3_600_000).toISOString();
}
