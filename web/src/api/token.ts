// Framework-agnostic session-token store. Kept out of React so the fetch wrapper can read
// the current token and clear it on 401 without importing component code. The AuthProvider
// subscribes to keep its state in sync.

const STORAGE_KEY = "streamarr.session";

export interface Session {
  token: string;
  username: string;
  role: string;
  expiresAt: string;
}

type Listener = (session: Session | null) => void;

let current: Session | null = load();
const listeners = new Set<Listener>();

function load(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    if (!parsed?.token) return null;
    // Drop obviously-expired sessions so we start at the login screen instead of 401-looping.
    if (parsed.expiresAt && new Date(parsed.expiresAt).getTime() <= Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function getSession(): Session | null {
  return current;
}

export function getToken(): string | null {
  return current?.token ?? null;
}

export function setSession(session: Session | null) {
  current = session;
  try {
    if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore storage failures (private mode etc.) — session still lives in memory
  }
  for (const l of listeners) l(session);
}

export function clearSession() {
  setSession(null);
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
