import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch, setUnauthorizedHandler, streamUrlWithToken } from "./client";
import { clearSession, getToken, setSession } from "./token";

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
    clearSession();
    setUnauthorizedHandler(null);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setUnauthorizedHandler(null);
  });

  it("injects the bearer token and returns parsed JSON", async () => {
    setSession({ token: "tok", username: "a", role: "admin", expiresAt: future() });
    const fetchMock = mockFetch({ status: 200, body: { hello: "world" } });
    vi.stubGlobal("fetch", fetchMock);

    const result = await apiFetch<{ hello: string }>("/health");

    expect(result).toEqual({ hello: "world" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/health");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
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
    setSession({ token: "tok", username: "a", role: "admin", expiresAt: future() });
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    vi.stubGlobal("fetch", mockFetch({ status: 401 }));

    await expect(apiFetch("/config/general")).rejects.toBeInstanceOf(ApiError);
    expect(getToken()).toBeNull();
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("returns undefined for 204 No Content", async () => {
    vi.stubGlobal("fetch", mockFetch({ status: 204 }));
    await expect(apiFetch("/config/apikeys/x", { method: "DELETE" })).resolves.toBeUndefined();
  });
});

describe("streamUrlWithToken", () => {
  beforeEach(() => clearSession());
  afterEach(() => clearSession());

  it("reduces an absolute stream URL to a same-origin path and appends the access token", () => {
    setSession({ token: "tok en", username: "a", role: "admin", expiresAt: future() });
    const url = streamUrlWithToken("http://192.168.1.5:8080/api/v1/stream/abc123");
    // same-origin path only, token url-encoded so a browser <video> can authenticate
    expect(url).toBe("/api/v1/stream/abc123?access_token=tok%20en");
  });

  it("accepts an already-relative path and preserves an existing query", () => {
    const url = streamUrlWithToken("/api/v1/stream/abc?x=1", "tok");
    expect(url).toBe("/api/v1/stream/abc?x=1&access_token=tok");
  });

  it("omits the token when none is available", () => {
    const url = streamUrlWithToken("http://host/api/v1/stream/abc", null);
    expect(url).toBe("/api/v1/stream/abc");
  });
});

function future(): string {
  return new Date(Date.now() + 3_600_000).toISOString();
}
