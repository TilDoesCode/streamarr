import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import { clearSession, setSession } from "@/api/token";
import { useAuth } from "./auth";

function AuthProbe() {
  const { session, login, logout } = useAuth();
  return (
    <div>
      <span>{session?.username ?? "signed out"}</span>
      <button type="button" onClick={() => void login({ username: "admin", password: "password" })}>
        Log in
      </button>
      <button type="button" onClick={logout}>
        Log out
      </button>
    </div>
  );
}

function response(status: number, body?: unknown): Promise<Response> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: new Headers(body === undefined ? {} : { "content-type": "application/json" }),
    text: () => Promise.resolve(body === undefined ? "" : JSON.stringify(body)),
    clone: () => ({ json: () => Promise.resolve(body) }),
  } as unknown as Response);
}

describe("AuthProvider cookie session", () => {
  beforeEach(() => {
    clearSession();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/auth/login") && init?.method === "POST") {
          return response(200, {
            token: "jwt-must-never-be-persisted",
            username: "admin",
            role: "admin",
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          });
        }
        if (url.endsWith("/auth/logout") && init?.method === "POST") return response(204);
        return response(404, { error: { code: "not_found", message: "no" } });
      }),
    );
  });

  afterEach(() => vi.restoreAllMocks());

  it("retains only non-secret metadata and expires the HttpOnly cookie on logout", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AuthProbe />);

    await user.click(screen.getByRole("button", { name: "Log in" }));
    await screen.findByText("admin");

    const raw = window.localStorage.getItem("streamarr.session") ?? "";
    expect(raw).not.toContain("jwt-must-never-be-persisted");
    expect(JSON.parse(raw)).not.toHaveProperty("token");
    expect(window.sessionStorage).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Log out" }));
    await waitFor(() => expect(window.localStorage.getItem("streamarr.session")).toBeNull());
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/auth/logout",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        keepalive: true,
      }),
    );
  });

  it("tears down an idle tab when its admin session metadata expires", async () => {
    vi.useFakeTimers();
    try {
      setSession({
        username: "admin",
        role: "admin",
        expiresAt: new Date(Date.now() + 1_000).toISOString(),
      });
      renderWithProviders(<AuthProbe />);
      expect(screen.getByText("admin")).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_001);
      });

      expect(screen.getByText("signed out")).toBeInTheDocument();
      expect(window.localStorage.getItem("streamarr.session")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
