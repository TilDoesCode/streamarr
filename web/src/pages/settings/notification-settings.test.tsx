import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import { setSession } from "@/api/token";
import { NotificationSettings } from "./notification-settings";

const config = {
  enabled: false,
  appToken: "••••••••",
  hasAppToken: true,
  userKey: "••••••••",
  hasUserKey: true,
  device: "",
  sound: "",
  notifyApplicationStarted: false,
  notifyPlaybackStarted: true,
  notifyPlaybackProgress: false,
  notifyPlaybackStopped: true,
  notifyResolveSucceeded: false,
  notifyResolveFailed: true,
  notifyErrors: true,
  notifyOutages: true,
  notifyRecoveries: true,
  includeUserName: true,
  includeDeviceName: true,
  includeReleaseId: false,
  usagePriority: 0,
  errorPriority: 1,
  outagePriority: 1,
  recoveryPriority: 0,
  progressIntervalMinutes: 30,
  errorCooldownSeconds: 300,
  monitorIntervalSeconds: 60,
  outageFailureThreshold: 3,
  outageReminderMinutes: 0,
  emergencyRetrySeconds: 60,
  emergencyExpireSeconds: 3600,
};

let saved: Record<string, unknown> | undefined;

describe("NotificationSettings", () => {
  beforeEach(() => {
    saved = undefined;
    setSession({ username: "admin", role: "admin", expiresAt: new Date(Date.now() + 3600000).toISOString() });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (String(input).includes("/config/notifications") && method === "GET")
        return response(200, config);
      if (String(input).includes("/config/notifications") && method === "PUT") {
        saved = JSON.parse(init?.body as string);
        return response(200, { ...config, ...saved });
      }
      return response(404, {});
    }));
  });

  afterEach(() => vi.restoreAllMocks());

  it("loads granular event switches and keeps configured credentials write-only", async () => {
    const user = userEvent.setup();
    renderWithProviders(<NotificationSettings />);

    const progress = await screen.findByRole("switch", { name: "Playback progress" });
    expect(progress).toHaveAttribute("aria-checked", "false");
    expect(screen.getByLabelText("Application API token")).toHaveAttribute("placeholder", "••••••••");

    await user.click(progress);
    await user.click(screen.getByRole("button", { name: /save notifications/i }));

    await waitFor(() => expect(saved).toBeDefined());
    expect(saved?.notifyPlaybackProgress).toBe(true);
    expect(saved).not.toHaveProperty("appToken");
    expect(saved).not.toHaveProperty("userKey");
  });
});

function response(status: number, body: unknown): Promise<Response> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: new Headers({ "content-type": "application/json" }),
    text: () => Promise.resolve(JSON.stringify(body)),
    clone: () => ({ json: () => Promise.resolve(body) }),
  } as unknown as Response);
}
