import type {
  ContentAccessResponse,
  NextUpResponse,
  ViewerAuthOptionsResponse,
  ViewerAuthResponse,
  ViewerChangePasswordRequest,
  ViewerCodeLoginRequest,
  ViewerDeviceSessionResponse,
  ViewerEmailChangeRequest,
  ViewerEmailChangeResponse,
  ViewerLoginRequest,
  ViewerPasswordResetRequest,
  ViewerProfileResponse,
  ViewerProfileUpdateRequest,
  ViewerRecoveryCodesResponse,
  ViewerSecondFactorRequest,
  ViewerSessionTokensResponse,
  ViewerTotpSetupResponse,
  WatchHistoryResponse,
  WatchMarkResponse,
  WatchProgressRequest,
  WatchStateResponse,
} from "@/api/types";

// Viewer-app client for /api/v1/viewer, independent of the admin fetch layer: in-memory bearer tokens, never cookies.

export interface ViewerTokens {
  sessionId: string;
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
}

export interface ViewerLogEntry {
  id: number;
  /** Epoch milliseconds when the request started. */
  at: number;
  method: string;
  path: string;
  /** `null` when the request never produced a response (network failure, abort). */
  status: number | null;
  durationMs: number;
  /** Redacted credential that was sent, e.g. "Bearer sva_…x9Qa"; `null` for anonymous calls. */
  auth: string | null;
  requestBody?: unknown;
  responseBody?: unknown;
  errorCode?: string;
  /** True for the replay of a request after a token refresh. */
  retry?: boolean;
}

export class ViewerApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ViewerApiError";
    this.status = status;
    this.code = code;
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

export interface ViewerRequestOptions {
  body?: unknown;
  query?: Query;
  /** Send the bearer token (default). Anonymous auth endpoints pass `false`. */
  auth?: boolean;
  signal?: AbortSignal;
}

interface RawResult {
  status: number;
  ok: boolean;
  data: unknown;
  token?: string | null;
}

const API_ROOT = "/api/v1/viewer";
const MASK = "••••";
const TOKEN_KEYS = new Set(["accessToken", "refreshToken", "mfaToken"]);
const SECRET_KEYS = new Set(["password", "currentPassword", "newPassword", "generatedPassword", "smtpPassword", "code", "secret"]);

/** "sva_abc…xyz" → "sva_…" + last four characters. */
export function redactToken(token: string): string {
  if (token.length <= 12) return MASK;
  const prefix = /^[a-z]{2,5}_/.exec(token)?.[0] ?? "";
  return `${prefix}…${token.slice(-4)}`;
}

/** Deep copy of a request/response body with tokens, passwords, codes and TOTP secrets masked. */
export function redact(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (parentKey === "error") out[key] = entry;
    else if (typeof entry === "string" && TOKEN_KEYS.has(key)) out[key] = redactToken(entry);
    else if (typeof entry === "string" && SECRET_KEYS.has(key)) out[key] = entry ? MASK : entry;
    else if (key === "recoveryCodes" && Array.isArray(entry)) out[key] = entry.map(() => MASK);
    else if (key === "otpAuthUri" && typeof entry === "string") out[key] = entry.replace(/secret=[^&]*/i, `secret=${MASK}`);
    else out[key] = redact(entry, key);
  }
  return out;
}

function isAuthPath(path: string): boolean {
  return path.startsWith("/auth/");
}

function buildPath(path: string, query?: Query): string {
  const url = `${API_ROOT}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

function toError(result: RawResult): ViewerApiError {
  const envelope = result.data as { error?: { code?: string | null; message?: string | null } } | undefined;
  const code = envelope?.error?.code ?? `http_${result.status}`;
  const message = envelope?.error?.message ?? `Request failed (${result.status}).`;
  return new ViewerApiError(result.status, code, message);
}

function toTokens(session: ViewerSessionTokensResponse | undefined): ViewerTokens {
  if (!session?.accessToken || !session.refreshToken || !session.sessionId) {
    throw new ViewerApiError(0, "missing_tokens", "The server did not return bearer tokens (cookie mode?).");
  }
  return {
    sessionId: session.sessionId,
    accessToken: session.accessToken,
    accessExpiresAt: session.accessExpiresAt,
    refreshToken: session.refreshToken,
    refreshExpiresAt: session.refreshExpiresAt,
  };
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export class ViewerClient {
  private current: ViewerTokens | null = null;
  private refreshing: Promise<ViewerTokens> | null = null;
  private readonly tokenListeners = new Set<(tokens: ViewerTokens | null) => void>();
  private readonly logListeners = new Set<(entry: ViewerLogEntry) => void>();
  private sequence = 0;

  constructor(private readonly fetchImpl?: typeof fetch) {}

  get tokens(): ViewerTokens | null {
    return this.current;
  }

  setTokens(tokens: ViewerTokens | null) {
    this.current = tokens;
    for (const listener of this.tokenListeners) listener(tokens);
  }

  /** Drop the tokens without telling the server (the session stays valid until it expires). */
  forget() {
    this.setTokens(null);
  }

  onTokens(listener: (tokens: ViewerTokens | null) => void): () => void {
    this.tokenListeners.add(listener);
    return () => this.tokenListeners.delete(listener);
  }

  onLog(listener: (entry: ViewerLogEntry) => void): () => void {
    this.logListeners.add(listener);
    return () => this.logListeners.delete(listener);
  }

  async request<T>(method: string, path: string, options: ViewerRequestOptions = {}): Promise<T> {
    const first = await this.send(method, path, options, false);
    if (first.status === 401 && options.auth !== false && !isAuthPath(path) && this.current) {
      // Skip the refresh when another call already rotated the token this request was sent with.
      if (first.token === this.current.accessToken) await this.refresh();
      return this.unwrap<T>(await this.send(method, path, options, true));
    }
    return this.unwrap<T>(first);
  }

  /** Rotate both tokens; concurrent callers share one refresh so the old token is never replayed. */
  refresh(): Promise<ViewerTokens> {
    if (this.refreshing) return this.refreshing;
    const before = this.current;
    if (!before) return Promise.reject(new ViewerApiError(401, "no_session", "There is no viewer session to refresh."));
    this.refreshing = (async () => {
      try {
        const result = await this.send("POST", "/auth/refresh", { body: { refreshToken: before.refreshToken }, auth: false }, false);
        if (!result.ok) {
          if (result.status === 401 && this.current === before) this.setTokens(null);
          throw toError(result);
        }
        const tokens = toTokens(result.data as ViewerSessionTokensResponse);
        if (this.current === before) this.setTokens(tokens);
        return tokens;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  // ---- auth ----

  authOptions() {
    return this.request<ViewerAuthOptionsResponse>("GET", "/auth/options", { auth: false });
  }

  async login(body: ViewerLoginRequest) {
    return this.adopt(await this.request<ViewerAuthResponse>("POST", "/auth/login", { body: { useCookies: false, ...body }, auth: false }));
  }

  async secondFactor(body: ViewerSecondFactorRequest) {
    return this.adopt(await this.request<ViewerAuthResponse>("POST", "/auth/login/second-factor", { body: { useCookies: false, ...body }, auth: false }));
  }

  requestEmailCode(login: string) {
    return this.request<void>("POST", "/auth/email-code", { body: { login }, auth: false });
  }

  async verifyEmailCode(body: ViewerCodeLoginRequest) {
    return this.adopt(await this.request<ViewerAuthResponse>("POST", "/auth/email-code/verify", { body: { useCookies: false, ...body }, auth: false }));
  }

  forgotPassword(login: string) {
    return this.request<void>("POST", "/auth/password/forgot", { body: { login }, auth: false });
  }

  resetPassword(body: ViewerPasswordResetRequest) {
    return this.request<void>("POST", "/auth/password/reset", { body, auth: false });
  }

  /** Revoke the session server-side; local tokens are dropped even when the call fails. */
  async logout() {
    const tokens = this.current;
    try {
      await this.request<void>("POST", "/auth/logout", { body: { refreshToken: tokens?.refreshToken } });
    } finally {
      if (this.current === tokens) this.setTokens(null);
    }
  }

  // ---- account ----

  me() {
    return this.request<ViewerProfileResponse>("GET", "/me");
  }

  updateMe(body: ViewerProfileUpdateRequest) {
    return this.request<ViewerProfileResponse>("PATCH", "/me", { body });
  }

  changePassword(body: ViewerChangePasswordRequest) {
    return this.request<void>("POST", "/me/password", { body });
  }

  changeEmail(body: ViewerEmailChangeRequest) {
    return this.request<ViewerEmailChangeResponse>("POST", "/me/email", { body });
  }

  verifyEmail(code: string) {
    return this.request<ViewerProfileResponse>("POST", "/me/email/verify", { body: { code } });
  }

  setupTwoFactor(currentPassword: string) {
    return this.request<ViewerTotpSetupResponse>("POST", "/me/two-factor/setup", { body: { currentPassword } });
  }

  enableTwoFactor(code: string) {
    return this.request<ViewerRecoveryCodesResponse>("POST", "/me/two-factor/enable", { body: { code } });
  }

  disableTwoFactor(currentPassword: string) {
    return this.request<void>("POST", "/me/two-factor/disable", { body: { currentPassword } });
  }

  regenerateRecoveryCodes(currentPassword: string) {
    return this.request<ViewerRecoveryCodesResponse>("POST", "/me/two-factor/recovery-codes", { body: { currentPassword } });
  }

  sessions() {
    return this.request<ViewerDeviceSessionResponse[]>("GET", "/me/sessions");
  }

  revokeSession(sessionId: string) {
    return this.request<void>("DELETE", `/me/sessions/${encodeURIComponent(sessionId)}`);
  }

  // ---- watch state ----

  progress(body: WatchProgressRequest) {
    return this.request<WatchStateResponse>("POST", "/watch/progress", { body });
  }

  markPlayed(workIds: string[]) {
    return this.request<WatchMarkResponse>("POST", "/watch/played", { body: { workIds } });
  }

  markUnplayed(workIds: string[]) {
    return this.request<WatchMarkResponse>("POST", "/watch/unplayed", { body: { workIds } });
  }

  resume(limit = 20) {
    return this.request<WatchStateResponse[]>("GET", "/watch/resume", { query: { limit } });
  }

  removeFromResume(workId: string) {
    return this.request<void>("DELETE", `/watch/resume/${encodeURIComponent(workId)}`);
  }

  nextUp({ limit = 20, seriesWorkId }: { limit?: number; seriesWorkId?: string } = {}) {
    return this.request<NextUpResponse>("GET", "/watch/next-up", { query: { limit, seriesWorkId } });
  }

  history({ limit = 50, offset = 0 }: { limit?: number; offset?: number } = {}) {
    return this.request<WatchHistoryResponse>("GET", "/watch/history", { query: { limit, offset } });
  }

  states(workIds: string[]) {
    return this.request<WatchStateResponse[]>("POST", "/watch/state", { body: { workIds } });
  }

  series(seriesWorkId: string) {
    return this.request<WatchStateResponse[]>("GET", `/watch/series/${encodeURIComponent(seriesWorkId)}`);
  }

  access(workId: string) {
    return this.request<ContentAccessResponse>("GET", `/access/${encodeURIComponent(workId)}`);
  }

  // ---- internals ----

  private adopt(response: ViewerAuthResponse): ViewerAuthResponse {
    if (response?.status === "authenticated") this.setTokens(toTokens(response.session));
    return response;
  }

  private unwrap<T>(result: RawResult): T {
    if (!result.ok) throw toError(result);
    return result.data as T;
  }

  private async send(method: string, path: string, options: ViewerRequestOptions, retry: boolean): Promise<RawResult> {
    const url = buildPath(path, options.query);
    const token = options.auth === false ? null : this.current?.accessToken ?? null;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;

    const entry: ViewerLogEntry = {
      id: ++this.sequence,
      at: Date.now(),
      method,
      path: url,
      status: null,
      durationMs: 0,
      auth: token ? `Bearer ${redactToken(token)}` : null,
      requestBody: options.body === undefined ? undefined : redact(options.body),
      retry: retry || undefined,
    };
    const started = now();
    try {
      const response = await (this.fetchImpl ?? globalThis.fetch)(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        credentials: "omit",
        cache: "no-store",
        signal: options.signal,
      });
      const text = await response.text();
      let data: unknown;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      entry.status = response.status;
      entry.responseBody = data === undefined ? undefined : redact(data);
      if (!response.ok) entry.errorCode = toError({ status: response.status, ok: false, data }).code;
      return { status: response.status, ok: response.ok, data, token };
    } catch (error) {
      entry.errorCode = error instanceof DOMException && error.name === "AbortError" ? "aborted" : "network_error";
      entry.responseBody = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      entry.durationMs = Math.max(0, Math.round(now() - started));
      for (const listener of this.logListeners) listener(entry);
    }
  }
}
