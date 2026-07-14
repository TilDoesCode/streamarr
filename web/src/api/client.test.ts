import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  abortAuthenticatedRequests,
  ApiError,
  apiFetch,
  requestAdminLogout,
  setUnauthorizedHandler,
  streamUrlForPlayback,
} from "./client";
import { clearSession, getSession, setSession } from "./token";

interface MockResponseInit {
  status: number;
  statusText?: string;
  headers?: HeadersInit;
  body?: unknown;
}

function mockFetch(response: MockResponseInit) {
  const headers = new Headers(response.headers ?? {});
  const text = response.body === undefined ? "" : JSON.stringify(response.body);
  const res = {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    statusText: response.statusText ?? "",
    headers,
    text: () => Promise.resolve(text),
    clone: () => ({ json: () => Promise.resolve(response.body) }),
  } as unknown as Response;
  return vi.fn().mockResolvedValue(res);
}

describe("apiFetch", () => {
  beforeEach(() => {
    abortAuthenticatedRequests();
    clearSession();
    setUnauthorizedHandler(null);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setUnauthorizedHandler(null);
  });

  it("uses same-origin cookie credentials without exposing an Authorization token", async () => {
    setSession({ username: "a", role: "admin", expiresAt: future() });
    const fetchMock = mockFetch({ status: 200, body: { hello: "world" } });
    vi.stubGlobal("fetch", fetchMock);

    const result = await apiFetch<{ hello: string }>("/health");

    expect(result).toEqual({ hello: "world" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/health");
    expect(init.credentials).toBe("same-origin");
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("builds query strings and drops nullish params", async () => {
    const fetchMock = mockFetch({ status: 200, body: {} });
    vi.stubGlobal("fetch", fetchMock);
    await apiFetch("/health", { query: { deep: false, skip: undefined } });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/health?deep=false");
  });

  it("throws a typed ApiError carrying the error envelope", async () => {
    const fetchMock = mockFetch({
      status: 400,
      body: { error: { code: "invalid_config", message: "bad" } },
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiFetch("/config/general", { method: "PUT", body: {} })).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
      message: "bad",
    });
  });

  it("on 401 clears the session and fires the unauthorized handler", async () => {
    setSession({ username: "a", role: "admin", expiresAt: future() });
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    vi.stubGlobal("fetch", mockFetch({ status: 401 }));

    await expect(apiFetch("/config/general")).rejects.toBeInstanceOf(ApiError);
    expect(getSession()).toBeNull();
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("returns undefined for 204 No Content", async () => {
    vi.stubGlobal("fetch", mockFetch({ status: 204 }));
    await expect(apiFetch("/config/apikeys/x", { method: "DELETE" })).resolves.toBeUndefined();
  });

  it("aborts in-flight authenticated requests when the session is reset", async () => {
    setSession({ username: "a", role: "admin", expiresAt: future() });
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Request aborted", "AbortError")),
          );
        }),
      ),
    );

    const pending = apiFetch("/sessions");
    abortAuthenticatedRequests();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("requests cookie logout as a keepalive same-origin POST", async () => {
    const fetchMock = mockFetch({ status: 204 });
    vi.stubGlobal("fetch", fetchMock);

    await requestAdminLogout();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/auth/logout");
    expect(init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      keepalive: true,
    });
  });
});

describe("streamUrlForPlayback", () => {
  beforeEach(() => clearSession());
  afterEach(() => clearSession());

  it("reduces an absolute stream URL to a same-origin capability path without the admin token", () => {
    setSession({ username: "a", role: "admin", expiresAt: future() });
    const url = streamUrlForPlayback("http://192.168.1.5:8080/api/v1/stream/abc123");
    expect(url).toBe("/api/v1/stream/abc123");
    expect(url).not.toContain("access_token");
  });

  it("accepts an already-relative path and preserves a server-provided query", () => {
    expect(streamUrlForPlayback("/api/v1/stream/abc?x=1")).toBe(
      "/api/v1/stream/abc?x=1",
    );
  });
});

function future(): string {
  return new Date(Date.now() + 3_600_000).toISOString();
}
