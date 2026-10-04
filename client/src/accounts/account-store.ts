import type { Account, SessionTokens, TokenVault } from './types';

export type KeyValueStorage = {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): boolean | void;
};

export type AccountsSnapshot = {
  readonly accounts: readonly Account[];
  readonly activeId: string | null;
};

export type SignedInViewer = {
  id: string;
  username: string;
  displayName: string;
  avatarKey?: string | null;
  mustChangePassword: boolean;
};

export type AccountStoreOptions = {
  storage: KeyValueStorage;
  vault: TokenVault;
  /** Web: this tab's own profile choice (sessionStorage), so a reload keeps it whatever other tabs picked. */
  tabStorage?: KeyValueStorage;
  now?: () => number;
  newId?: () => string;
};

/** MMKV instance of the account list (web: localStorage keys `streamarr.accounts\…`). */
export const ACCOUNTS_STORAGE_ID = 'streamarr.accounts';
const LIST_KEY = 'accounts';
export const AVATAR_COLORS = 8;
/** Server avatar keys in the order of the client's colour slots (docs/api.md, PATCH /viewer/me). */
export const AVATAR_KEYS = [
  'cyan',
  'blue',
  'teal',
  'green',
  'amber',
  'coral',
  'rose',
  'slate',
] as const;
const ACTIVE_KEY = 'active';

function randomId(): string {
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function isAccount(value: unknown): value is Account {
  const account = value as Partial<Account> | null;
  return (
    !!account &&
    typeof account.id === 'string' &&
    typeof account.serverUrl === 'string' &&
    typeof account.viewerId === 'string' &&
    typeof account.username === 'string'
  );
}

function parseAccounts(raw: string | undefined): Account[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isAccount)
      .map((account) => ({ ...account, color: profileColor(account.viewerId, account.avatarKey) }));
  } catch {
    return [];
  }
}

const sameUser = (account: Account, serverUrl: string, viewerId: string, username: string) =>
  account.serverUrl === serverUrl &&
  (account.viewerId === viewerId || account.username.toLowerCase() === username.toLowerCase());

/** One profile per (server, user): a server reset changes viewer ids, so the username also identifies it. */
function dedupeAccounts(accounts: readonly Account[]): {
  accounts: Account[];
  dropped: Map<string, string>;
} {
  const rank = (account: Account) => [account.signedIn ? 1 : 0, account.lastUsedAt ?? 0];
  const kept: Account[] = [];
  const dropped = new Map<string, string>();
  for (const account of accounts) {
    const index = kept.findIndex((item) =>
      sameUser(item, account.serverUrl, account.viewerId, account.username)
    );
    if (index < 0) {
      kept.push(account);
      continue;
    }
    const [a, b] = [rank(kept[index]!), rank(account)];
    const better = b[0]! > a[0]! || (b[0] === a[0] && b[1]! > a[1]!);
    const loser = better ? kept[index]! : account;
    if (better) kept[index] = account;
    dropped.set(loser.id, kept[index]!.id);
  }
  for (const [from, to] of dropped) {
    let target = to;
    while (dropped.has(target)) target = dropped.get(target)!;
    dropped.set(from, target);
  }
  return { accounts: kept, dropped };
}

/** Avatar colour slot: the chosen avatar key, else a pure function of the viewer id (same on every device). */
export function profileColor(viewerId: string, avatarKey?: string | null): number {
  const chosen = AVATAR_KEYS.indexOf(avatarKey?.toLowerCase() as (typeof AVATAR_KEYS)[number]);
  if (chosen >= 0) return chosen;
  let hash = 0x811c9dc5;
  for (const char of viewerId) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return hash % AVATAR_COLORS;
}

const hasId = (accounts: readonly Account[], id: string | null | undefined): id is string =>
  !!id && accounts.some((account) => account.id === id);

type EndedListener = (account: Account, code: string) => void;

/** Earliest retry of a vault write that failed (the pair stays usable in memory meanwhile). */
export const VAULT_RETRY_MS = 5_000;

/** Remembered accounts (list in MMKV/localStorage, tokens in the vault); changes re-read the stored list first. */
export class AccountStore {
  private snapshot: AccountsSnapshot;
  /** The list JSON as last read or written here; a different stored value means another tab changed it. */
  private raw: string | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly endedListeners = new Set<EndedListener>();
  private readonly tokenCache = new Map<string, SessionTokens>();
  /** Rotated pairs the vault refused to store: still the valid ones for this run; the write is retried on a later read. */
  private readonly unsaved = new Map<string, { tokens: SessionTokens; retryAt: number }>();
  private readonly storage: KeyValueStorage;
  private readonly tabStorage: KeyValueStorage | undefined;
  private readonly vault: TokenVault;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor({
    storage,
    vault,
    tabStorage,
    now = Date.now,
    newId = randomId,
  }: AccountStoreOptions) {
    this.storage = storage;
    this.tabStorage = tabStorage;
    this.vault = vault;
    this.now = now;
    this.newId = newId;
    this.raw = storage.getString(LIST_KEY);
    const { accounts, dropped } = dedupeAccounts(parseAccounts(this.raw));
    if (dropped.size) {
      this.raw = JSON.stringify(accounts);
      storage.set(LIST_KEY, this.raw);
      for (const id of dropped.keys()) void vault.remove(id).catch(() => undefined);
    }
    const mapped = (id: string | undefined) => (id && dropped.get(id)) ?? id;
    const tabActive = mapped(tabStorage?.getString(ACTIVE_KEY));
    const lastActive = mapped(storage.getString(ACTIVE_KEY));
    this.snapshot = {
      accounts,
      activeId: hasId(accounts, tabActive)
        ? tabActive
        : hasId(accounts, lastActive)
          ? lastActive
          : null,
    };
  }

  getSnapshot = (): AccountsSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Called when a session ends without the user signing out (refresh reuse, expiry, disabled account). */
  onSessionEnded(listener: EndedListener): () => void {
    this.endedListeners.add(listener);
    return () => this.endedListeners.delete(listener);
  }

  get(id: string): Account | undefined {
    return this.snapshot.accounts.find((account) => account.id === id);
  }

  active(): Account | undefined {
    return this.snapshot.activeId ? this.get(this.snapshot.activeId) : undefined;
  }

  /** Picks up list changes made elsewhere (another tab); this tab's active profile stays unless removed. */
  reload(): void {
    if (this.sync()) this.notify();
  }

  /** Forgets tokens held in memory (another tab rotated or removed them); all of them without an id. */
  forgetCachedTokens(id?: string): void {
    if (id === undefined) {
      this.tokenCache.clear();
      this.unsaved.clear();
    } else {
      this.tokenCache.delete(id);
      this.unsaved.delete(id);
    }
  }

  /** Adds or refreshes the account for (server, viewer) after a successful sign-in and stores its tokens. */
  async addSignedIn(
    server: { url: string; name: string },
    viewer: SignedInViewer,
    tokens: SessionTokens
  ): Promise<Account> {
    this.reload();
    const matches = this.snapshot.accounts.filter((account) =>
      sameUser(account, server.url, viewer.id, viewer.username)
    );
    const known = matches.find((account) => account.viewerId === viewer.id) ?? matches[0];
    const id = known?.id ?? this.newId();
    const stale = matches.filter((account) => account.id !== id).map((account) => account.id);
    for (const staleId of stale) {
      this.tokenCache.delete(staleId);
      this.unsaved.delete(staleId);
      await this.vault.remove(staleId);
    }
    await this.writeTokens(id, tokens);
    const now = this.now();
    this.mutate(({ accounts, activeId }) => {
      const existing = accounts.find((account) => account.id === id);
      const account: Account = {
        id,
        serverUrl: server.url,
        serverName: server.name,
        viewerId: viewer.id,
        username: viewer.username,
        displayName: viewer.displayName || viewer.username,
        avatarKey: viewer.avatarKey ?? null,
        color: profileColor(viewer.id, viewer.avatarKey),
        signedIn: true,
        mustChangePassword: viewer.mustChangePassword,
        addedAt: existing?.addedAt ?? now,
        lastUsedAt: now,
      };
      const rest = accounts.filter((item) => !stale.includes(item.id));
      return {
        accounts: existing
          ? rest.map((item) => (item.id === id ? account : item))
          : [...rest, account],
        activeId: activeId && stale.includes(activeId) ? id : activeId,
      };
    });
    return this.get(id)!;
  }

  setActive(id: string | null): void {
    const changed = this.mutate(({ accounts }) => {
      if (id === null) return { accounts, activeId: null };
      if (!hasId(accounts, id)) return undefined;
      return {
        accounts: accounts.map((account) =>
          account.id === id ? { ...account, lastUsedAt: this.now() } : account
        ),
        activeId: id,
      };
    });
    if (!changed) return;
    // The profile offered first on the next launch (web: after a reload of this tab, or in a new tab).
    for (const target of [this.storage, this.tabStorage]) {
      if (id) target?.set(ACTIVE_KEY, id);
      else target?.remove(ACTIVE_KEY);
    }
  }

  update(id: string, patch: Partial<Omit<Account, 'id'>>): void {
    this.mutate(({ accounts, activeId }) =>
      hasId(accounts, id)
        ? {
            accounts: accounts.map((account) =>
              account.id === id ? { ...account, ...patch } : account
            ),
            activeId,
          }
        : undefined
    );
  }

  /** Tokens from memory; `fresh` re-reads the vault (another browser tab may have rotated them). */
  async readTokens(id: string, fresh = false): Promise<SessionTokens | null> {
    const pending = this.unsaved.get(id);
    if (pending) {
      // A failing Keystore is not hammered on every request: one write attempt per interval.
      if (this.now() >= pending.retryAt) await this.persist(id, pending.tokens);
      return pending.tokens;
    }
    if (!fresh) {
      const cached = this.tokenCache.get(id);
      if (cached) return cached;
    }
    let stored: SessionTokens | null;
    try {
      stored = await this.vault.get(id);
    } catch (error) {
      // A storage hiccup is not a sign-out: keep using the pair this process holds, else fail transiently.
      const cached = this.tokenCache.get(id);
      if (cached) return cached;
      throw error;
    }
    if (stored) this.tokenCache.set(id, stored);
    else this.tokenCache.delete(id);
    return stored;
  }

  /** Persists first: a rotated pair must never be used before it survives an app kill. */
  async writeTokens(id: string, tokens: SessionTokens): Promise<void> {
    this.unsaved.delete(id);
    await this.persist(id, tokens);
    this.tokenCache.set(id, tokens);
  }

  /** A failed vault write keeps the pair for this run: the old refresh token is spent once the server rotated. */
  private async persist(id: string, tokens: SessionTokens): Promise<void> {
    try {
      await this.vault.set(id, tokens);
      this.unsaved.delete(id);
    } catch {
      this.unsaved.set(id, { tokens, retryAt: this.now() + VAULT_RETRY_MS });
    }
  }

  /** Forgets the tokens, keeps the profile; `endedReason` = ended by the server. Already signed out: no change. */
  async signOut(id: string, endedReason?: string): Promise<void> {
    const changed = this.mutate(({ accounts, activeId }) =>
      accounts.find((account) => account.id === id)?.signedIn
        ? {
            accounts: accounts.map((account) =>
              account.id === id ? { ...account, signedIn: false, endedReason } : account
            ),
            activeId,
          }
        : undefined
    );
    this.tokenCache.delete(id);
    this.unsaved.delete(id);
    await this.vault.remove(id);
    const account = this.get(id);
    if (changed && endedReason && account)
      this.endedListeners.forEach((listener) => listener(account, endedReason));
  }

  /** Removes the profile from this device (tokens included). */
  async remove(id: string): Promise<void> {
    this.tokenCache.delete(id);
    this.unsaved.delete(id);
    await this.vault.remove(id);
    this.mutate(({ accounts, activeId }) =>
      hasId(accounts, id)
        ? { accounts: accounts.filter((account) => account.id !== id), activeId }
        : undefined
    );
    for (const target of [this.storage, this.tabStorage])
      if (target?.getString(ACTIVE_KEY) === id) target.remove(ACTIVE_KEY);
  }

  /** Re-reads the stored list; false when nothing changed since the last read or write. */
  private sync(): boolean {
    const raw = this.storage.getString(LIST_KEY);
    if (raw === this.raw) return false;
    this.raw = raw;
    const accounts = parseAccounts(raw);
    const { activeId } = this.snapshot;
    this.snapshot = { accounts, activeId: hasId(accounts, activeId) ? activeId : null };
    return true;
  }

  /** Read-modify-write on the stored list, so a stale snapshot never overwrites another tab's change. */
  private mutate(change: (current: AccountsSnapshot) => AccountsSnapshot | undefined): boolean {
    const reloaded = this.sync();
    const next = change(this.snapshot);
    if (next) {
      if (next.accounts !== this.snapshot.accounts) {
        this.raw = JSON.stringify(next.accounts);
        this.storage.set(LIST_KEY, this.raw);
      }
      this.snapshot = {
        accounts: next.accounts,
        activeId: hasId(next.accounts, next.activeId) ? next.activeId : null,
      };
    }
    if (next || reloaded) this.notify();
    return !!next;
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }
}
