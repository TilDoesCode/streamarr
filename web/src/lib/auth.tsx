import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { apiFetch } from "@/api/client";
import { clearSession, getSession, setSession, subscribe, type Session } from "@/api/token";
import type { LoginRequest, LoginResponse } from "@/api/types";

interface AuthContextValue {
  session: Session | null;
  isAuthenticated: boolean;
  login: (credentials: LoginRequest) => Promise<Session>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setLocal] = useState<Session | null>(() => getSession());

  // Keep React state in sync with the module-level token store (which the fetch layer
  // clears on 401), so an expired session immediately flips the guard to logged-out.
  useEffect(() => subscribe(setLocal), []);

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
          token: res.token ?? "",
          username: res.username ?? credentials.username ?? "",
          role: res.role ?? "",
          expiresAt: res.expiresAt,
        };
        setSession(next);
        return next;
      },
      logout() {
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
