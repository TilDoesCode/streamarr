import { describe, expect, it, beforeEach } from "vitest";
import { clearSession, getSession, getToken, setSession, subscribe } from "./token";

describe("token store", () => {
  beforeEach(() => {
    localStorage.clear();
    clearSession();
  });

  it("persists and reads back a session", () => {
    setSession({ token: "abc", username: "admin", role: "admin", expiresAt: farFuture() });
    expect(getToken()).toBe("abc");
    expect(getSession()?.username).toBe("admin");
    expect(localStorage.getItem("streamarr.session")).toContain("abc");
  });

  it("clearSession wipes token and storage", () => {
    setSession({ token: "abc", username: "admin", role: "admin", expiresAt: farFuture() });
    clearSession();
    expect(getToken()).toBeNull();
    expect(localStorage.getItem("streamarr.session")).toBeNull();
  });

  it("notifies subscribers on change", () => {
    const seen: (string | null)[] = [];
    const unsub = subscribe((s) => seen.push(s?.token ?? null));
    setSession({ token: "x", username: "a", role: "admin", expiresAt: farFuture() });
    clearSession();
    unsub();
    expect(seen).toEqual(["x", null]);
  });
});

function farFuture(): string {
  return new Date(Date.now() + 3_600_000).toISOString();
}
