import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import { setSession } from "@/api/token";
import { ProvidersPage } from "./providers";

const providers = [
  {
    id: "provider-1",
    name: "Primary",
    host: "news.primary.test",
    port: 563,
    useSsl: true,
    username: "streamarr",
    hasPassword: true,
    maxConnections: 12,
    priority: 0,
    enabled: true,
    isBackupOnly: false,
  },
  {
    id: "provider-2",
    name: "Block account",
    host: "news.block.test",
    port: 563,
    useSsl: true,
    username: "streamarr",
    hasPassword: true,
    maxConnections: 4,
    priority: 1,
    enabled: true,
    isBackupOnly: true,
  },
];

let orderBodies: Array<Record<string, unknown>> = [];

function installFetch() {
  orderBodies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/config/providers") && method === "GET") {
        return jsonResponse(200, providers);
      }
      if (url.endsWith("/config/providers/order") && method === "PUT") {
        orderBodies.push(init?.body ? JSON.parse(init.body as string) : {});
        return jsonResponse(204, {});
      }
      return jsonResponse(404, { error: { code: "not_found", message: "no" } });
    }),
  );
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

describe("ProvidersPage", () => {
  beforeEach(() => {
    setSession({
      username: "admin",
      role: "admin",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    installFetch();
  });

  afterEach(() => vi.restoreAllMocks());

  it("reorders providers with one atomic order request", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProvidersPage />);
    await screen.findByText("Primary");

    await user.click(screen.getByRole("button", { name: /move primary down/i }));

    await waitFor(() =>
      expect(orderBodies).toEqual([{ ids: ["provider-2", "provider-1"] }]),
    );
  });
});
