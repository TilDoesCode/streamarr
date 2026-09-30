/** A viewer account on one server, remembered on this device. Non-secret; tokens live in the vault. */
export type Account = {
  /** Local id (lowercase letters and digits; safe as a storage key). */
  id: string;
  serverUrl: string;
  serverName: string;
  viewerId: string;
  username: string;
  displayName: string;
  /** Avatar colour slot derived from the viewer id (probing past slots other local profiles use). */
  color: number;
  /** False after sign-out or when the server ended the session; the profile stays in the picker. */
  signedIn: boolean;
  mustChangePassword: boolean;
  /** Error code when the session ended without the user signing out (e.g. refresh_token_reused). */
  endedReason?: string;
  addedAt: number;
  lastUsedAt: number;
};

export type SessionTokens = {
  sessionId: string;
  accessToken: string;
  /** Epoch milliseconds. */
  accessExpiresAt: number;
  refreshToken: string;
  refreshExpiresAt: number;
};

/** Web vault's MMKV instance (localStorage keys `streamarr.vault\<account id>`). */
export const WEB_VAULT_STORAGE_ID = 'streamarr.vault';

/** Secret storage for session tokens (SecureStore on native, localStorage on web, memory in tests). */
export type TokenVault = {
  get(accountId: string): Promise<SessionTokens | null>;
  set(accountId: string, tokens: SessionTokens): Promise<void>;
  remove(accountId: string): Promise<void>;
};

export function parseTokens(raw: string | null | undefined): SessionTokens | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<SessionTokens>;
    return typeof value.accessToken === 'string' &&
      typeof value.refreshToken === 'string' &&
      typeof value.accessExpiresAt === 'number' &&
      typeof value.refreshExpiresAt === 'number'
      ? (value as SessionTokens)
      : null;
  } catch {
    return null;
  }
}

export function createMemoryVault(): TokenVault & { entries: Map<string, SessionTokens> } {
  const entries = new Map<string, SessionTokens>();
  return {
    entries,
    get: async (id) => entries.get(id) ?? null,
    set: async (id, tokens) => void entries.set(id, tokens),
    remove: async (id) => void entries.delete(id),
  };
}
