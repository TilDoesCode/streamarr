import { describe, expect, it, beforeEach, vi } from "vitest";
import { clearSession, getSession, setSession, subscribe } from "./token";

describe("token store", () => {
  beforeEach(() => {
    localStorage.clear();
    clearSession();
  });

  it("persists only non-secret session metadata", () => {
    const expiresAt = farFuture();
    setSession({ username: "admin", role: "admin", expiresAt });
    expect(getSession()?.username).toBe("admin");
    const stored = JSON.parse(localStorage.getItem("streamarr.session")!) as Record<string, unknown>;
    expect(stored).toEqual({ username: "admin", role: "admin", expiresAt });
    expect(stored).not.toHaveProperty("token");
    expect(sessionStorage).toHaveLength(0);
  });

  it("keeps an expired access record while its refresh session is still valid", () => {
    const refreshExpiresAt = farFuture();
    window.dispatchEvent(new StorageEvent("storage", {
      key: "streamarr.session",
      newValue: JSON.stringify({
        username: "admin",
        role: "admin",
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
        refreshExpiresAt,
      }),
    }));

    expect(getSession()).toMatchObject({ username: "admin", refreshExpiresAt });
  });

  it("clearSession wipes metadata and storage", () => {
    const cleared = vi.fn();
    window.addEventListener("streamarr:session-cleared", cleared, { once: true });
    setSession({ username: "admin", role: "admin", expiresAt: farFuture() });
    clearSession();
    expect(getSession()).toBeNull();
    expect(localStorage.getItem("streamarr.session")).toBeNull();
    expect(cleared).toHaveBeenCalledOnce();
  });

  it("notifies subscribers on change", () => {
    const seen: (string | null)[] = [];
    const unsub = subscribe((s) => seen.push(s?.username ?? null));
    setSession({ username: "a", role: "admin", expiresAt: farFuture() });
    clearSession();
    unsub();
    expect(seen).toEqual(["a", null]);
  });

  it("synchronizes logout events from another tab", () => {
    setSession({ username: "a", role: "admin", expiresAt: farFuture() });
    const seen: (string | null)[] = [];
    const unsub = subscribe((s) => seen.push(s?.username ?? null));

    window.dispatchEvent(
      new StorageEvent("storage", { key: "streamarr.session", newValue: null }),
    );

    expect(getSession()).toBeNull();
    expect(seen).toEqual([null]);
    unsub();
  });

  it("sanitizes legacy cross-tab records that still contain a JWT", () => {
    const legacy = JSON.stringify({
      token: "legacy-jwt-secret",
      username: "admin",
      role: "admin",
      expiresAt: farFuture(),
    });

    window.dispatchEvent(
      new StorageEvent("storage", { key: "streamarr.session", newValue: legacy }),
    );

    expect(getSession()?.username).toBe("admin");
    expect(window.localStorage.getItem("streamarr.session")).not.toContain("legacy-jwt-secret");
    expect(JSON.parse(window.localStorage.getItem("streamarr.session")!)).not.toHaveProperty(
      "token",
    );
  });
});

function farFuture(): string {
  return new Date(Date.now() + 3_600_000).toISOString();
}
