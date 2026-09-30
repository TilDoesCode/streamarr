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
    return parsed.filter(isAccount).map((account, index) => ({
      ...account,
      color: typeof account.color === 'number' ? account.color : index % AVATAR_COLORS,
    }));
  } catch {
    return [];
  }
}

const sameUser = (account: Account, serverUrl: string, viewerId: string, username: string) =>
  account.serverUrl === serverUrl &&
  (account.viewerId === viewerId || account.username.toLowerCase() === username.toLowerCase());

/** One profile per (server, user): a server reset changes viewer ids, so the username also identifies it. */
export function dedupeAccounts(accounts: readonly Account[]): {
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

function freeColor(accounts: readonly Account[]): number {
  const used = new Set(accounts.map((account) => account.color));
  for (let color = 0; color < AVATAR_COLORS; color += 1) if (!used.has(color)) return color;
  return accounts.length % AVATAR_COLORS;
}

const hasId = (accounts: readonly Account[], id: string | null | undefined): id is string =>
  !!id && accounts.some((account) => account.id === id);

type EndedListener = (account: Account, code: string) => void;

/** Remembered accounts (list in MMKV/localStorage, tokens in the vault); changes re-read the stored list first. */
export class AccountStore {
  private snapshot: AccountsSnapshot;
  /** The list JSON as last read or written here; a different stored value means another tab changed it. */
  private raw: string | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly endedListeners = new Set<EndedListener>();
  private readonly tokenCache = new Map<string, SessionTokens>();
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
    if (id === undefined) this.tokenCache.clear();
    else this.tokenCache.delete(id);
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
        color: existing?.color ?? freeColor(accounts),
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
    if (!fresh) {
      const cached = this.tokenCache.get(id);
      if (cached) return cached;
    }
    const stored = await this.vault.get(id);
    if (stored) this.tokenCache.set(id, stored);
    else this.tokenCache.delete(id);
    return stored;
  }

  async writeTokens(id: string, tokens: SessionTokens): Promise<void> {
    this.tokenCache.set(id, tokens);
    await this.vault.set(id, tokens);
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
    await this.vault.remove(id);
    const account = this.get(id);
    if (changed && endedReason && account)
      this.endedListeners.forEach((listener) => listener(account, endedReason));
  }

  /** Removes the profile from this device (tokens included). */
  async remove(id: string): Promise<void> {
    this.tokenCache.delete(id);
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
