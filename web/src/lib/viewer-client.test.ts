import { describe, expect, it, vi } from "vitest";
import { ViewerApiError, ViewerClient, redact, redactToken, type ViewerLogEntry, type ViewerTokens } from "./viewer-client";

const ACCESS = `sva_${"a".repeat(39)}AcC1`;
const ACCESS_2 = `sva_${"b".repeat(39)}AcC2`;
const REFRESH = `svr_${"c".repeat(39)}ReF1`;
const REFRESH_2 = `svr_${"d".repeat(39)}ReF2`;

function tokens(overrides: Partial<ViewerTokens> = {}): ViewerTokens {
  return {
    sessionId: "s1",
    accessToken: ACCESS,
    accessExpiresAt: "2026-09-28T12:00:00Z",
    refreshToken: REFRESH,
    refreshExpiresAt: "2026-10-28T12:00:00Z",
    ...overrides,
  };
}

function json(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Call = { url: string; init: RequestInit };

function mockFetch(...responses: Response[]) {
  const calls: Call[] = [];
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses.shift();
    return next ? Promise.resolve(next) : Promise.reject(new TypeError("Failed to fetch"));
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

function header(call: Call, name: string): string | undefined {
  return (call.init.headers as Record<string, string> | undefined)?.[name];
}

describe("ViewerClient", () => {
  it("sends the bearer token with credentials omitted and parses JSON", async () => {
    const { fetch, calls } = mockFetch(json(200, { id: "v1", username: "alice" }));
    const client = new ViewerClient(fetch);
    client.setTokens(tokens());

    const me = await client.me();

    expect(me).toEqual({ id: "v1", username: "alice" });
    expect(calls[0].url).toBe("/api/v1/viewer/me");
    expect(calls[0].init.credentials).toBe("omit");
    expect(header(calls[0], "Authorization")).toBe(`Bearer ${ACCESS}`);
    expect(header(calls[0], "Accept")).toBe("application/json");
  });

  it("serializes JSON bodies and query strings, and sends anonymous auth calls without a token", async () => {
    const { fetch, calls } = mockFetch(json(200, { items: [], incomplete: false }), json(202));
    const client = new ViewerClient(fetch);
    client.setTokens(tokens());

    await client.nextUp({ limit: 5, seriesWorkId: "tmdb-tv-1396" });
    await client.requestEmailCode("alice");

    expect(calls[0].url).toBe("/api/v1/viewer/watch/next-up?limit=5&seriesWorkId=tmdb-tv-1396");
    expect(calls[1].init.body).toBe(JSON.stringify({ login: "alice" }));
    expect(header(calls[1], "Content-Type")).toBe("application/json");
    expect(header(calls[1], "Authorization")).toBeUndefined();
  });

  it("maps the error envelope to a ViewerApiError with status, code and message", async () => {
    const { fetch } = mockFetch(json(423, { error: { code: "account_locked", message: "Locked for 15 minutes." } }));
    const client = new ViewerClient(fetch);

    const error = await client.login({ login: "alice", password: "wrong" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ViewerApiError);
    expect(error).toMatchObject({ status: 423, code: "account_locked", message: "Locked for 15 minutes." });
  });

  it("falls back to http_<status> for bodies without an envelope", async () => {
    const { fetch } = mockFetch(new Response("oops", { status: 502 }));
    const client = new ViewerClient(fetch);
    await expect(client.authOptions()).rejects.toMatchObject({ status: 502, code: "http_502" });
  });

  it("adopts the tokens of an authenticated sign-in but not of an MFA challenge", async () => {
    const session = { sessionId: "s9", accessToken: ACCESS, accessExpiresAt: "x", refreshToken: REFRESH, refreshExpiresAt: "y", cookieMode: false };
    const { fetch, calls } = mockFetch(
      json(200, { status: "mfa_required", mfaToken: `svm_${"m".repeat(43)}` }),
      json(200, { status: "authenticated", session, viewer: { id: "v1", username: "alice" } }),
    );
    const client = new ViewerClient(fetch);
    const seen = vi.fn();
    client.onTokens(seen);

    const challenge = await client.login({ login: "alice", password: "pw", deviceName: "Test" });
    expect(challenge.status).toBe("mfa_required");
    expect(client.tokens).toBeNull();
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ useCookies: false, deviceName: "Test" });

    await client.secondFactor({ mfaToken: challenge.mfaToken, code: "123456" });
    expect(client.tokens).toMatchObject({ sessionId: "s9", accessToken: ACCESS, refreshToken: REFRESH });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("refreshes once on a 401 and replays the request with the new token", async () => {
    const { fetch, calls } = mockFetch(
      json(401, { error: { code: "unauthorized", message: "expired" } }),
      json(200, { sessionId: "s1", accessToken: ACCESS_2, accessExpiresAt: "a", refreshToken: REFRESH_2, refreshExpiresAt: "b", cookieMode: false }),
      json(200, []),
    );
    const client = new ViewerClient(fetch);
    const log: ViewerLogEntry[] = [];
    client.onLog((entry) => log.push(entry));
    client.setTokens(tokens());

    await expect(client.resume()).resolves.toEqual([]);

    expect(calls.map((call) => call.url)).toEqual([
      "/api/v1/viewer/watch/resume?limit=20",
      "/api/v1/viewer/auth/refresh",
      "/api/v1/viewer/watch/resume?limit=20",
    ]);
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ refreshToken: REFRESH });
    expect(header(calls[1], "Authorization")).toBeUndefined();
    expect(header(calls[2], "Authorization")).toBe(`Bearer ${ACCESS_2}`);
    expect(client.tokens).toMatchObject({ accessToken: ACCESS_2, refreshToken: REFRESH_2 });
    expect(log.map((entry) => [entry.status, entry.retry ?? false])).toEqual([[401, false], [200, false], [200, true]]);
  });

  it("does not loop when the replay is rejected again", async () => {
    const { fetch, calls } = mockFetch(
      json(401, { error: { code: "unauthorized", message: "a" } }),
      json(200, { sessionId: "s1", accessToken: ACCESS_2, accessExpiresAt: "a", refreshToken: REFRESH_2, refreshExpiresAt: "b", cookieMode: false }),
      json(401, { error: { code: "unauthorized", message: "still no" } }),
    );
    const client = new ViewerClient(fetch);
    client.setTokens(tokens());

    await expect(client.me()).rejects.toMatchObject({ status: 401, message: "still no" });
    expect(calls).toHaveLength(3);
  });

  it("drops the tokens when the refresh token is rejected", async () => {
    const { fetch } = mockFetch(
      json(401, { error: { code: "unauthorized", message: "a" } }),
      json(401, { error: { code: "refresh_token_reused", message: "This refresh token was already used." } }),
    );
    const client = new ViewerClient(fetch);
    client.setTokens(tokens());

    await expect(client.me()).rejects.toMatchObject({ code: "refresh_token_reused" });
    expect(client.tokens).toBeNull();
  });

  it("never refreshes for auth endpoints", async () => {
    const { fetch, calls } = mockFetch(json(401, { error: { code: "invalid_credentials", message: "Incorrect username or password." } }));
    const client = new ViewerClient(fetch);
    client.setTokens(tokens());

    await expect(client.login({ login: "alice", password: "x" })).rejects.toMatchObject({ code: "invalid_credentials" });
    expect(calls).toHaveLength(1);
    expect(client.tokens).not.toBeNull();
  });

  it("shares one refresh between concurrent 401s so the refresh token is used once", async () => {
    const { fetch, calls } = mockFetch(
      json(401, { error: { code: "unauthorized", message: "a" } }),
      json(401, { error: { code: "unauthorized", message: "b" } }),
      json(200, { sessionId: "s1", accessToken: ACCESS_2, accessExpiresAt: "a", refreshToken: REFRESH_2, refreshExpiresAt: "b", cookieMode: false }),
      json(200, { id: "v1" }),
      json(200, []),
    );
    const client = new ViewerClient(fetch);
    client.setTokens(tokens());

    await Promise.all([client.me(), client.sessions()]);

    expect(calls.filter((call) => call.url.endsWith("/auth/refresh"))).toHaveLength(1);
  });

  it("forgets the tokens on logout even when the server call fails", async () => {
    const { fetch, calls } = mockFetch(json(500, { error: { code: "boom", message: "boom" } }));
    const client = new ViewerClient(fetch);
    client.setTokens(tokens());

    await expect(client.logout()).rejects.toMatchObject({ status: 500 });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ refreshToken: REFRESH });
    expect(header(calls[0], "Authorization")).toBe(`Bearer ${ACCESS}`);
    expect(client.tokens).toBeNull();
  });

  it("logs every call with redacted bodies and credentials", async () => {
    const session = { sessionId: "s1", accessToken: ACCESS, accessExpiresAt: "x", refreshToken: REFRESH, refreshExpiresAt: "y", cookieMode: false };
    const { fetch } = mockFetch(json(200, { status: "authenticated", session, viewer: { id: "v1" } }), json(200, { id: "v1" }));
    const client = new ViewerClient(fetch);
    const log: ViewerLogEntry[] = [];
    client.onLog((entry) => log.push(entry));

    await client.login({ login: "alice", password: "hunter22" });
    await client.me();

    expect(log[0]).toMatchObject({ method: "POST", path: "/api/v1/viewer/auth/login", status: 200, auth: null });
    expect(log[0].requestBody).toMatchObject({ login: "alice", password: "••••" });
    expect(log[0].responseBody).toMatchObject({ session: { accessToken: "sva_…AcC1", refreshToken: "svr_…ReF1" } });
    expect(JSON.stringify(log)).not.toContain("hunter22");
    expect(JSON.stringify(log)).not.toContain(ACCESS);
    expect(log[1].auth).toBe("Bearer sva_…AcC1");
    expect(log[1].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("logs network failures without a status", async () => {
    const { fetch } = mockFetch();
    const client = new ViewerClient(fetch);
    const log: ViewerLogEntry[] = [];
    client.onLog((entry) => log.push(entry));

    await expect(client.authOptions()).rejects.toThrow("Failed to fetch");
    expect(log[0]).toMatchObject({ status: null, errorCode: "network_error" });
  });
});

describe("redaction", () => {
  it("keeps the token prefix and the last four characters", () => {
    expect(redactToken(ACCESS)).toBe("sva_…AcC1");
    expect(redactToken("short")).toBe("••••");
  });

  it("masks passwords, codes, recovery codes and TOTP secrets deeply", () => {
    expect(
      redact({
        currentPassword: "a",
        newPassword: "b",
        code: "ABCD-EFGH",
        nested: [{ mfaToken: `svm_${"x".repeat(39)}Wxyz` }],
        recoveryCodes: ["aaaaa-bbbbb", "ccccc-ddddd"],
        secret: "JBSWY3DPEHPK3PXP",
        otpAuthUri: "otpauth://totp/S:alice?secret=JBSWY3DPEHPK3PXP&issuer=S",
        username: "alice",
      }),
    ).toEqual({
      currentPassword: "••••",
      newPassword: "••••",
      code: "••••",
      nested: [{ mfaToken: "svm_…Wxyz" }],
      recoveryCodes: ["••••", "••••"],
      secret: "••••",
      otpAuthUri: "otpauth://totp/S:alice?secret=••••&issuer=S",
      username: "alice",
    });
  });

  it("keeps error envelope codes readable", () => {
    expect(redact({ error: { code: "invalid_credentials", message: "Incorrect username or password." } })).toEqual({
      error: { code: "invalid_credentials", message: "Incorrect username or password." },
    });
  });
});
