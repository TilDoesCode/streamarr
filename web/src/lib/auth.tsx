import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, apiFetch, refreshAdminSession, requestAdminLogout } from "@/api/client";
import { clearSession, getSession, setSession, subscribe, type Session } from "@/api/token";
import type { LoginRequest, LoginResponse } from "@/api/types";

interface AuthContextValue {
  session: Session | null;
  isAuthenticated: boolean;
  login: (credentials: LoginRequest) => Promise<Session>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({
  children,
  onSignedOut,
}: {
  children: ReactNode;
  onSignedOut?: () => void;
}) {
  const [session, setLocal] = useState<Session | null>(() => getSession());
  const previousSession = useRef(session);

  // Keep React state in sync with the module-level metadata store (which the fetch layer
  // clears on 401), so an expired session immediately flips the guard to logged-out.
  useEffect(
    () =>
      subscribe((next) => {
        const wasAuthenticated = previousSession.current !== null;
        previousSession.current = next;
        setLocal(next);
        if (wasAuthenticated && next === null) onSignedOut?.();
      }),
    [onSignedOut],
  );

  // Refresh shortly before the access cookie expires. An idle or newly reopened tab refreshes
  // immediately when its access deadline has passed but its refresh session is still valid.
  useEffect(() => {
    if (!session) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const refreshWhenDue = async () => {
      const now = Date.now();
      const refreshDeadline = Date.parse(session.refreshExpiresAt ?? session.expiresAt);
      if (!Number.isFinite(refreshDeadline) || refreshDeadline <= now) {
        clearSession();
        return;
      }
      const refreshIn = Date.parse(session.expiresAt) - now - 5 * 60_000;
      if (Number.isFinite(refreshIn) && refreshIn > 0) {
        timer = setTimeout(() => void refreshWhenDue(), Math.min(refreshIn, 2_147_483_647));
        return;
      }

      try {
        await refreshAdminSession();
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) {
          clearSession();
          return;
        }
        timer = setTimeout(
          () => void refreshWhenDue(),
          Math.min(60_000, Math.max(1, refreshDeadline - Date.now())),
        );
      }
    };

    void refreshWhenDue();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [session]);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      isAuthenticated: session !== null,
      async login(credentials) {
        const res = await apiFetch<LoginResponse>("/auth/login", {
          method: "POST",
          body: credentials,
        });
        const next: Session = {
          username: res.username ?? credentials.username ?? "",
          role: res.role ?? "",
          expiresAt: res.expiresAt,
          refreshExpiresAt: res.refreshExpiresAt,
        };
        setSession(next);
        return next;
      },
      logout() {
        // Start the keepalive request while the HttpOnly cookie is still present, then tear down
        // local UI state immediately even if the server is temporarily unreachable.
        void requestAdminLogout().catch(() => undefined);
        clearSession();
      },
    }),
    [session],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
