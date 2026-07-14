// Framework-agnostic, non-secret session-metadata store. The actual admin credential is an
// HttpOnly cookie and never enters JavaScript. AuthProvider subscribes to this metadata so a
// 401 or cross-tab logout can tear down the authenticated UI immediately.

const STORAGE_KEY = "streamarr.session";
export const SESSION_CLEARED_EVENT = "streamarr:session-cleared";

export interface Session {
  username: string;
  role: string;
  expiresAt: string;
}

type Listener = (session: Session | null) => void;

let current: Session | null = load();
const listeners = new Set<Listener>();

function load(): Session | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const session = parse(raw);
    if (session) {
      // Rewrite records created by older releases so a previously-persisted JWT is removed.
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    } else {
      // Invalid/expired legacy data must not leave an old credential at rest.
      window.localStorage.removeItem(STORAGE_KEY);
    }
    return session;
  } catch {
    return null;
  }
}

function parse(raw: string): Session | null {
  try {
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (
      typeof parsed?.username !== "string" ||
      !parsed.username ||
      typeof parsed.role !== "string" ||
      typeof parsed.expiresAt !== "string"
    ) return null;
    // Drop obviously-expired sessions so we start at the login screen instead of 401-looping.
    const expiresAt = Date.parse(parsed.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
    return {
      username: parsed.username,
      role: parsed.role ?? "",
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

function publish(session: Session | null) {
  const wasAuthenticated = current !== null;
  current = session;
  if (wasAuthenticated && session === null && typeof window !== "undefined") {
    window.dispatchEvent(new Event(SESSION_CLEARED_EVENT));
  }
  for (const listener of listeners) listener(session);
}

export function getSession(): Session | null {
  return current;
}

export function setSession(session: Session | null) {
  try {
    if (typeof window !== "undefined") {
      if (session) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
      else window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // ignore storage failures (private mode etc.) — session still lives in memory
  }
  publish(session);
}

export function clearSession() {
  setSession(null);
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// `storage` is delivered to every *other* tab. Updating the in-memory copy here makes a
// logout, login, or token refresh take effect across all open management-console tabs.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    const session = event.newValue ? parse(event.newValue) : null;
    try {
      if (session) {
        // Also sanitize records written by an older Streamarr tab still open during an upgrade.
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
      } else if (event.newValue) {
        window.localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // The in-memory session still updates when storage is unavailable.
    }
    publish(session);
  });
}
