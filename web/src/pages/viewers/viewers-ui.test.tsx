import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setSession } from "@/api/token";
import { installFetchRoutes } from "@/test/fetch-routes";
import { renderWithProviders } from "@/test/render";
import { AccountsTab } from "./accounts-tab";
import { HarnessTab } from "./harness/harness-tab";
import { useHarnessState } from "./harness/use-harness";
import { SettingsTab } from "./settings-tab";

const ACCESS = `sva_${"a".repeat(39)}AcC1`;
const REFRESH = `svr_${"c".repeat(39)}ReF1`;
const MFA = `svm_${"m".repeat(39)}MfA1`;

function future(ms = 3_600_000) {
  return new Date(Date.now() + ms).toISOString();
}

function settings(overrides: Record<string, unknown> = {}, email: Record<string, unknown> = {}) {
  return {
    enabled: true,
    serverName: "Streamarr",
    accessTokenMinutes: 60,
    refreshTokenDays: 30,
    maxSessionsPerViewer: 20,
    passwordMinLength: 8,
    lockoutThreshold: 10,
    lockoutMinutes: 15,
    allowPasswordReset: true,
    allowEmailLogin: true,
    allowTotp: true,
    minResumePercent: 5,
    playedPercent: 90,
    minResumeDurationSeconds: 300,
    nextUpCutoffDays: 365,
    email: {
      mode: "outbox",
      smtpHost: "",
      smtpPort: 587,
      smtpSecurity: "startTls",
      smtpUsername: "",
      smtpPassword: null,
      fromAddress: "",
      fromName: "Streamarr",
      ...email,
    },
    emailDeliveryReady: true,
    viewerCount: 2,
    ...overrides,
  };
}

function viewer(overrides: Record<string, unknown> = {}) {
  return {
    accountType: "viewer",
    id: "v1",
    username: "alice",
    displayName: "Alice",
    email: "alice@example.com",
    emailVerified: true,
    pendingEmail: null,
    disabled: false,
    lockedUntil: null,
    mustChangePassword: false,
    twoFactorEnabled: false,
    permissions: { maxAge: null, blockUnrated: false, allowTranscoding: true, maxConcurrentStreams: null },
    activeSessions: 1,
    playedCount: 3,
    inProgressCount: 1,
    lastPlayedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    lastLoginAt: new Date(Date.now() - 120_000).toISOString(),
    ...overrides,
  };
}

function profile(overrides: Record<string, unknown> = {}) {
  return {
    accountType: "viewer",
    id: "v1",
    username: "alice",
    displayName: "Alice",
    email: "alice@example.com",
    emailVerified: true,
    mustChangePassword: false,
    twoFactorEnabled: true,
    recoveryCodesRemaining: 10,
    permissions: { maxAge: 16, blockUnrated: false, allowTranscoding: true, maxConcurrentStreams: null },
    ...overrides,
  };
}

const kid = viewer({
  id: "v2",
  username: "kid",
  displayName: "Kid",
  email: null,
  emailVerified: false,
  lockedUntil: future(),
  twoFactorEnabled: true,
  mustChangePassword: true,
  activeSessions: 0,
  permissions: { maxAge: 12, blockUnrated: true, allowTranscoding: true, maxConcurrentStreams: 1 },
});

beforeEach(() => setSession({ username: "admin", role: "admin", expiresAt: future() }));
afterEach(() => vi.restoreAllMocks());

describe("Viewer accounts", () => {
  it("lists viewers as viewer accounts with their limits and flags, and unlocks a locked one", async () => {
    const user = userEvent.setup();
    const { requests } = installFetchRoutes({
      "GET /api/v1/config/viewers": () => [viewer(), kid],
      "GET /api/v1/config/viewers/settings": () => settings(),
      "PATCH /api/v1/config/viewers/v2": () => ({ ...kid, lockedUntil: null }),
    });
    renderWithProviders(<AccountsTab />);

    const alice = await screen.findByRole("listitem", { name: "Alice (@alice)" });
    expect(within(alice).getByText("Viewer")).toBeVisible();
    expect(within(alice).getByText("Unrestricted")).toBeVisible();
    expect(within(alice).getByText("alice@example.com")).toBeVisible();
    expect(within(alice).queryByRole("button", { name: "Reset 2FA @alice" })).not.toBeInTheDocument();
    expect(screen.getByText(/not administrators and cannot sign in to this console/i)).toBeVisible();

    const row = screen.getByRole("listitem", { name: "Kid (@kid)" });
    expect(within(row).getByText("12+")).toBeVisible();
    expect(within(row).getByText("blocks unrated · max 1 stream")).toBeVisible();
    expect(within(row).getByText("2FA")).toBeVisible();
    expect(within(row).getByText("Locked")).toBeVisible();
    expect(within(row).getByText("Must change password")).toBeVisible();
    expect(within(row).getByRole("button", { name: "Reset 2FA @kid" })).toBeVisible();

    await user.click(within(row).getByRole("button", { name: "Unlock @kid" }));
    await waitFor(() => expect(requests.find((r) => r.method === "PATCH")?.body).toEqual({ unlock: true }));
    await waitFor(() => expect(within(row).queryByText("Locked")).not.toBeInTheDocument());
  });

  it("creates a viewer with a generated password and shows it exactly once", async () => {
    const user = userEvent.setup();
    const { requests } = installFetchRoutes({
      "GET /api/v1/config/viewers": () => [],
      "GET /api/v1/config/viewers/settings": () => settings(),
      "POST /api/v1/config/viewers": () => ({
        status: 201,
        body: { viewer: viewer({ id: "v3", username: "bob", displayName: "bob", mustChangePassword: true }), generatedPassword: "abcd-efgh-jkmn" },
      }),
    });
    renderWithProviders(<AccountsTab />);

    expect(await screen.findByText("No viewer accounts yet")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /new viewer/i }));
    const form = await screen.findByRole("form", { name: "New viewer" });
    await user.type(within(form).getByLabelText("Username"), "b");
    await user.click(within(form).getByRole("button", { name: /create viewer/i }));
    expect(await within(form).findByText(/3–32 characters/)).toBeVisible();
    expect(requests.some((r) => r.method === "POST")).toBe(false);

    await user.type(within(form).getByLabelText("Username"), "ob");
    await user.selectOptions(within(form).getByLabelText("Age limit"), "12");
    await user.click(within(form).getByRole("switch", { name: "Block unrated titles" }));
    await user.click(within(form).getByRole("button", { name: /create viewer/i }));

    await waitFor(() => expect(requests.some((r) => r.method === "POST")).toBe(true));
    expect(requests.find((r) => r.method === "POST")?.body).toEqual({
      username: "bob",
      mustChangePassword: true,
      permissions: { maxAge: 12, blockUnrated: true, allowTranscoding: true, maxConcurrentStreams: null },
      disabled: false,
    });
    expect(await screen.findByLabelText("Generated password for @bob")).toHaveTextContent("abcd-efgh-jkmn");
    expect(screen.getByText(/shown only once/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: /i copied it/i }));
    await waitFor(() => expect(screen.queryByText("abcd-efgh-jkmn")).not.toBeInTheDocument());
  });

  it("deletes a viewer after confirmation", async () => {
    const user = userEvent.setup();
    const { requests } = installFetchRoutes({
      "GET /api/v1/config/viewers": () => [viewer()],
      "GET /api/v1/config/viewers/settings": () => settings(),
      "DELETE /api/v1/config/viewers/v1": () => ({ status: 204 }),
    });
    renderWithProviders(<AccountsTab />);

    await user.click(await screen.findByRole("button", { name: "Delete @alice" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete @alice?" });
    await user.click(within(dialog).getByRole("button", { name: "Delete viewer" }));
    await waitFor(() => expect(requests.some((r) => r.method === "DELETE" && r.path === "/api/v1/config/viewers/v1")).toBe(true));
  });

  it("offers to enable the module while it is disabled", async () => {
    const user = userEvent.setup();
    const { requests } = installFetchRoutes({
      "GET /api/v1/config/viewers": () => [],
      "GET /api/v1/config/viewers/settings": () => settings({ enabled: false }),
      "PUT /api/v1/config/viewers/settings": () => settings({ enabled: true }),
    });
    renderWithProviders(<AccountsTab />);

    expect(await screen.findByText("The viewer module is switched off")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /enable module/i }));
    await waitFor(() => expect(requests.find((r) => r.method === "PUT")?.body).toEqual({ enabled: true }));
    await waitFor(() => expect(screen.queryByText("The viewer module is switched off")).not.toBeInTheDocument());
  });
});

describe("Viewer settings", () => {
  it("requires host and sender for SMTP and keeps the write-only password unless it is replaced or removed", async () => {
    const user = userEvent.setup();
    const { requests } = installFetchRoutes({
      "GET /api/v1/config/viewers/settings": () => settings({}, { mode: "disabled", smtpPassword: "••••••••" }),
      "PUT /api/v1/config/viewers/settings": (request) => {
        const body = request.body as { email: Record<string, unknown> };
        return settings({}, { ...body.email, smtpPassword: body.email.smtpPassword === "" ? null : "••••••••" });
      },
    });
    renderWithProviders(<SettingsTab />);

    await user.selectOptions(await screen.findByLabelText("Delivery mode"), "smtp");
    const save = screen.getByRole("button", { name: /save viewer settings/i });
    await user.click(save);
    expect(await screen.findByText("SMTP delivery needs a host")).toBeVisible();
    expect(screen.getByText("SMTP delivery needs a sender address")).toBeVisible();
    expect(requests.some((r) => r.method === "PUT")).toBe(false);

    await user.type(screen.getByLabelText("SMTP host"), "smtp.example.com");
    await user.type(screen.getByLabelText("From address"), "tv@example.com");
    expect(screen.getByLabelText("Password")).toHaveAttribute("placeholder", "•••••••• (saved)");
    await user.click(save);

    await waitFor(() => expect(requests.filter((r) => r.method === "PUT")).toHaveLength(1));
    const first = requests.find((r) => r.method === "PUT")?.body as { email: Record<string, unknown>; enabled: boolean };
    expect(first.enabled).toBe(true);
    expect(first.email).toEqual({
      mode: "smtp",
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      smtpSecurity: "startTls",
      smtpUsername: "",
      fromAddress: "tv@example.com",
      fromName: "Streamarr",
    });

    await user.click(await screen.findByRole("checkbox", { name: "Remove the saved password" }));
    await user.click(save);
    await waitFor(() => expect(requests.filter((r) => r.method === "PUT")).toHaveLength(2));
    expect((requests.filter((r) => r.method === "PUT")[1].body as { email: Record<string, unknown> }).email.smtpPassword).toBe("");
  });
});

function HarnessHost() {
  const harness = useHarnessState();
  return <HarnessTab harness={harness} />;
}

function harnessRoutes(overrides: Record<string, (request: { body: unknown }) => unknown> = {}) {
  const session = { sessionId: "sess1", accessToken: ACCESS, accessExpiresAt: future(), refreshToken: REFRESH, refreshExpiresAt: future(30 * 86_400_000), cookieMode: false };
  return installFetchRoutes({
    "GET /api/v1/config/viewers/settings": () => settings(),
    "GET /api/v1/config/viewers": () => [viewer(), kid],
    "GET /api/v1/config/viewers/outbox": () => [
      { id: "m1", createdAt: new Date().toISOString(), to: "alice@example.com", subject: "Your sign-in code", kind: "login_code", text: "Use QX7P-4MZ2 to sign in." },
    ],
    "GET /api/v1/viewer/auth/options": () => ({ serverName: "Streamarr", passwordLogin: true, emailCodeLogin: true, passwordReset: false, twoFactor: true, passwordMinLength: 8 }),
    "POST /api/v1/viewer/auth/login": () => ({ status: "mfa_required", mfaToken: MFA, mfaExpiresAt: future(300_000) }),
    "POST /api/v1/viewer/auth/login/second-factor": () => ({ status: "authenticated", session, viewer: profile() }),
    "GET /api/v1/viewer/me": () => profile(),
    "GET /api/v1/viewer/watch/resume": () => [],
    "GET /api/v1/viewer/watch/next-up": () => ({ items: [], incomplete: false }),
    "GET /api/v1/viewer/watch/history": () => ({ items: [], total: 0 }),
    ...overrides,
  });
}

describe("Viewer test harness", () => {
  it("signs in with password and second factor using only its own bearer token", async () => {
    const user = userEvent.setup();
    const { requests, fetchMock } = harnessRoutes();
    renderWithProviders(<HarnessHost />);

    expect(await screen.findByRole("tab", { name: /forgot password/i })).toBeDisabled();
    await user.click(await screen.findByRole("button", { name: "@alice" }));
    await user.type(screen.getByLabelText("Password", { selector: "input" }), "correct horse");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await user.type(await screen.findByLabelText("Authenticator or recovery code"), "123456");
    await user.click(screen.getByRole("button", { name: "Verify" }));

    const sessionPanel = await screen.findByRole("region", { name: "Viewer session" });
    expect(within(sessionPanel).getByText("Alice")).toBeVisible();
    expect(within(sessionPanel).getByText("Viewer")).toBeVisible();
    expect(within(sessionPanel).getByText("sva_…AcC1")).toBeVisible();
    expect(within(sessionPanel).getByText(/Age limit: 16\+/)).toBeVisible();
    expect(await screen.findByRole("region", { name: "Player simulator" })).toBeVisible();

    expect(requests.find((r) => r.path === "/api/v1/viewer/auth/login")?.body).toEqual({
      useCookies: false,
      login: "alice",
      password: "correct horse",
      deviceName: "Test harness",
      clientName: "Streamarr test harness",
    });
    expect(requests.find((r) => r.path.endsWith("/second-factor"))?.body).toMatchObject({ mfaToken: MFA, code: "123456" });

    await waitFor(() => expect(requests.some((r) => r.path === "/api/v1/viewer/watch/resume")).toBe(true));
    const viewerCalls = fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/v1/viewer/"));
    for (const [, init] of viewerCalls) expect(init?.credentials).toBe("omit");
    const auth = (url: string) =>
      (fetchMock.mock.calls.find(([u]) => String(u).startsWith(url))?.[1]?.headers as Record<string, string>).Authorization;
    expect(auth("/api/v1/viewer/auth/login")).toBeUndefined();
    expect(auth("/api/v1/viewer/watch/resume")).toBe(`Bearer ${ACCESS}`);
    const adminCall = fetchMock.mock.calls.find(([url]) => String(url).startsWith("/api/v1/config/viewers"));
    expect(adminCall?.[1]?.credentials).toBe("same-origin");

    const apiLog = screen.getByRole("list", { name: "API calls" });
    expect(within(apiLog).getByText("/viewer/auth/login/second-factor")).toBeInTheDocument();
    expect(apiLog).toHaveTextContent("svm_…MfA1");
    expect(apiLog).not.toHaveTextContent("correct horse");
    expect(apiLog).not.toHaveTextContent(ACCESS);
    expect(apiLog).not.toHaveTextContent("123456");

    const mail = await screen.findByRole("list", { name: "Codes in this mail" });
    expect(within(mail).getByText("QX7P-4MZ2")).toBeVisible();
    expect(within(mail).getByRole("button", { name: "Copy code QX7P-4MZ2" })).toBeVisible();
  });

  it("shows the forced password change before anything else", async () => {
    const user = userEvent.setup();
    let mustChange = true;
    const session = { sessionId: "sess2", accessToken: ACCESS, accessExpiresAt: future(), refreshToken: REFRESH, refreshExpiresAt: future(), cookieMode: false };
    const { requests } = harnessRoutes({
      "POST /api/v1/viewer/auth/login": () => ({ status: "authenticated", session, viewer: profile({ mustChangePassword: true, twoFactorEnabled: false }) }),
      "GET /api/v1/viewer/me": () => profile({ mustChangePassword: mustChange, twoFactorEnabled: false }),
      "POST /api/v1/viewer/me/password": () => {
        mustChange = false;
        return { status: 204 };
      },
    });
    renderWithProviders(<HarnessHost />);

    await user.type(await screen.findByLabelText("Username or email"), "alice");
    await user.type(screen.getByLabelText("Password", { selector: "input" }), "assigned-1");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    const forced = await screen.findByRole("region", { name: "Password change required" });
    expect(screen.queryByRole("region", { name: "Player simulator" })).not.toBeInTheDocument();
    await user.type(within(forced).getByLabelText("Current password"), "assigned-1");
    await user.type(within(forced).getByLabelText("New password"), "my-own-secret");
    await user.type(within(forced).getByLabelText("Repeat new password"), "my-own-secret");
    await user.click(within(forced).getByRole("button", { name: "Change password" }));

    expect(await screen.findByRole("region", { name: "Player simulator" })).toBeVisible();
    expect(requests.find((r) => r.path === "/api/v1/viewer/me/password")?.body).toEqual({ currentPassword: "assigned-1", newPassword: "my-own-secret" });
  });
});
