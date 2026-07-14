import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { apiFetch, requestAdminLogout } from "@/api/client";
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

  // The cookie expires independently in the browser, but an idle tab may not make another
  // request that would surface a 401. Expire the local session metadata on the same deadline so
  // route guards and active players tear down even when the tab is otherwise idle. Long-lived
  // sessions are scheduled in safe setTimeout-sized chunks.
  useEffect(() => {
    if (!session) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const expireWhenDue = () => {
      const remaining = Date.parse(session.expiresAt) - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0) {
        clearSession();
        return;
      }
      timer = setTimeout(expireWhenDue, Math.min(remaining, 2_147_483_647));
    };

    expireWhenDue();
    return () => {
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
