import {
  AccountStore,
  AVATAR_COLORS,
  AVATAR_KEYS,
  profileColor,
  type KeyValueStorage,
} from '@/accounts/account-store';
import {
  followOtherTabs,
  tabSessionStorage,
  type StorageEventTarget,
} from '@/accounts/browser-tabs';
import { createMemoryVault, parseTokens, type SessionTokens } from '@/accounts/types';

function memoryStorage(): KeyValueStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getString: (key) => map.get(key),
    set: (key, value) => void map.set(key, value),
    remove: (key) => map.delete(key),
  };
}

const tokens = (n: number): SessionTokens => ({
  sessionId: `s${n}`,
  accessToken: `sva_${n}`,
  accessExpiresAt: 1_000_000 + n,
  refreshToken: `svr_${n}`,
  refreshExpiresAt: 2_000_000 + n,
});

const viewer = (id: string, username: string, mustChangePassword = false) => ({
  id,
  username,
  displayName: username[0]!.toUpperCase() + username.slice(1),
  mustChangePassword,
});

const DEV_WORLD = { url: 'http://10.0.2.2:39300', name: 'Dev World' };
const OTHER = { url: 'https://media.example.com', name: 'Friends' };

function setup() {
  const storage = memoryStorage();
  const vault = createMemoryVault();
  let n = 0;
  let clock = 100;
  const store = new AccountStore({
    storage,
    vault,
    now: () => (clock += 1),
    newId: () => `acc${(n += 1)}`,
  });
  return { storage, vault, store };
}

describe('AccountStore', () => {
  it('adds several accounts on several servers and keeps their tokens in the vault', async () => {
    const { store, vault } = setup();
    const anna = await store.addSignedIn(DEV_WORLD, viewer('v-anna', 'anna'), tokens(1));
    const ben = await store.addSignedIn(DEV_WORLD, viewer('v-ben', 'ben'), tokens(2));
    const friend = await store.addSignedIn(OTHER, viewer('v-anna', 'anna'), tokens(3));
    expect(store.getSnapshot().accounts.map((account) => account.id)).toEqual([
      anna.id,
      ben.id,
      friend.id,
    ]);
    expect(anna).toMatchObject({ signedIn: true, displayName: 'Anna', serverName: 'Dev World' });
    expect(vault.entries.get(ben.id)).toEqual(tokens(2));
    // Same viewer id on another server is another account.
    expect(friend.id).not.toBe(anna.id);
  });

  it('derives the avatar colour only from the viewer id, whatever else is stored', async () => {
    const alone = await setup().store.addSignedIn(DEV_WORLD, viewer('v-anna', 'anna'), tokens(1));
    const crowded = setup().store;
    for (const name of ['zed', 'mia', 'ben', 'kind'])
      await crowded.addSignedIn(DEV_WORLD, viewer(`v-${name}`, name), tokens(1));
    const late = await crowded.addSignedIn(DEV_WORLD, viewer('v-anna', 'anna'), tokens(1));
    expect(late.color).toBe(alone.color);
    expect(profileColor('v-anna')).toBe(alone.color);
    expect(profileColor('v-anna')).toBe(profileColor('v-anna'));
    expect(profileColor('v-anna')).toBeLessThan(AVATAR_COLORS);
  });

  it('uses the chosen avatar key as the colour slot', async () => {
    expect(AVATAR_KEYS.map((key) => profileColor('v-anna', key))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(profileColor('v-anna', 'CORAL')).toBe(5);
    expect(profileColor('v-anna', 'plaid')).toBe(profileColor('v-anna'));
    expect(profileColor('v-anna', null)).toBe(profileColor('v-anna'));
    const store = new AccountStore({ storage: memoryStorage(), vault: createMemoryVault() });
    const anna = await store.addSignedIn(
      DEV_WORLD,
      { ...viewer('v-anna', 'anna'), avatarKey: 'rose' },
      tokens(1)
    );
    expect(anna).toMatchObject({ avatarKey: 'rose', color: 6 });
  });

  it('ignores stored colours and load order when reading the account list', () => {
    const storage = memoryStorage();
    const stored = ['v-mia', 'v-anna'].map((viewerId, index) => ({
      id: `a${index}`,
      serverUrl: DEV_WORLD.url,
      viewerId,
      username: viewerId.slice(2),
      displayName: viewerId.slice(2),
      color: 7 - index,
      signedIn: false,
      addedAt: 1,
    }));
    storage.set('accounts', JSON.stringify(stored));
    const forward = new AccountStore({ storage, vault: createMemoryVault() }).getSnapshot()
      .accounts;
    storage.set('accounts', JSON.stringify([...stored].reverse()));
    const backward = new AccountStore({ storage, vault: createMemoryVault() }).getSnapshot()
      .accounts;
    for (const account of [...forward, ...backward])
      expect(account.color).toBe(profileColor(account.viewerId));
  });

  it('signing in again to the same server and viewer updates the existing account', async () => {
    const { store, vault } = setup();
    const first = await store.addSignedIn(DEV_WORLD, viewer('v-anna', 'anna'), tokens(1));
    await store.signOut(first.id, 'refresh_token_reused');
    const again = await store.addSignedIn(DEV_WORLD, viewer('v-anna', 'anna'), tokens(2));
    expect(again.id).toBe(first.id);
    expect(again.color).toBe(first.color);
    expect(store.getSnapshot().accounts).toHaveLength(1);
    expect(store.get(first.id)?.signedIn).toBe(true);
    expect(store.get(first.id)?.endedReason).toBeUndefined();
    expect(vault.entries.get(first.id)).toEqual(tokens(2));
  });

  it('a server reset (new viewer id) updates the same user instead of adding a tile', async () => {
    const { store } = setup();
    const first = await store.addSignedIn(DEV_WORLD, viewer('v-anna', 'anna'), tokens(1));
    const again = await store.addSignedIn(DEV_WORLD, viewer('v-anna-2', 'Anna'), tokens(2));
    expect(again.id).toBe(first.id);
    expect(again.viewerId).toBe('v-anna-2');
    expect(store.getSnapshot().accounts).toHaveLength(1);
  });

  it('merges duplicates stored by older versions on load', async () => {
    const { storage, vault } = setup();
    const base = { serverUrl: DEV_WORLD.url, serverName: 'Dev World', username: 'anna' };
    const account = (id: string, viewerId: string, lastUsedAt: number, signedIn: boolean) => ({
      ...base,
      id,
      viewerId,
      displayName: 'Anna',
      color: 0,
      signedIn,
      mustChangePassword: false,
      addedAt: 1,
      lastUsedAt,
    });
    storage.set(
      'accounts',
      JSON.stringify([
        account('a1', 'v1', 5, false),
        account('a2', 'v2', 9, true),
        account('a3', 'v3', 7, true),
      ])
    );
    storage.set('active', 'a1');
    await vault.set('a1', tokens(1));
    const store = new AccountStore({ storage, vault });
    expect(store.getSnapshot().accounts.map((item) => item.id)).toEqual(['a2']);
    expect(store.getSnapshot().activeId).toBe('a2');
    await Promise.resolve();
    expect(vault.entries.has('a1')).toBe(false);
  });

  it('switches the active account and persists the choice', async () => {
    const { store, storage, vault } = setup();
    const anna = await store.addSignedIn(DEV_WORLD, viewer('v-anna', 'anna'), tokens(1));
    const ben = await store.addSignedIn(DEV_WORLD, viewer('v-ben', 'ben'), tokens(2));
    store.setActive(anna.id);
    expect(store.active()?.username).toBe('anna');
    store.setActive(ben.id);
    expect(store.active()?.username).toBe('ben');
    store.setActive('missing');
    expect(store.active()?.username).toBe('ben');

    const reloaded = new AccountStore({ storage, vault });
    expect(reloaded.getSnapshot().activeId).toBe(ben.id);
    expect(reloaded.getSnapshot().accounts.map((account) => account.username)).toEqual([
      'anna',
      'ben',
    ]);
    await expect(reloaded.readTokens(ben.id)).resolves.toEqual(tokens(2));
  });

  it('sign-out forgets the tokens but keeps the profile; a session end is reported', async () => {
    const { store, vault } = setup();
    const ended = jest.fn();
    store.onSessionEnded(ended);
    const anna = await store.addSignedIn(DEV_WORLD, viewer('v-anna', 'anna'), tokens(1));
    const ben = await store.addSignedIn(DEV_WORLD, viewer('v-ben', 'ben'), tokens(2));

    await store.signOut(anna.id);
    expect(store.get(anna.id)).toMatchObject({ signedIn: false, endedReason: undefined });
    expect(vault.entries.has(anna.id)).toBe(false);
    await expect(store.readTokens(anna.id)).resolves.toBeNull();
    expect(ended).not.toHaveBeenCalled();

    await store.signOut(ben.id, 'refresh_session_expired');
    expect(ended).toHaveBeenCalledWith(
      expect.objectContaining({ id: ben.id, signedIn: false }),
      'refresh_session_expired'
    );
  });

  it('remove drops the profile, its tokens and the active selection', async () => {
    const { store, vault } = setup();
    const anna = await store.addSignedIn(DEV_WORLD, viewer('v-anna', 'anna'), tokens(1));
    const ben = await store.addSignedIn(DEV_WORLD, viewer('v-ben', 'ben'), tokens(2));
    store.setActive(ben.id);
    await store.remove(ben.id);
    expect(store.getSnapshot()).toEqual({ accounts: [store.get(anna.id)], activeId: null });
    expect(vault.entries.has(ben.id)).toBe(false);
  });

  it('notifies subscribers with a new snapshot on every change', async () => {
    const { store } = setup();
    const listener = jest.fn();
    const unsubscribe = store.subscribe(listener);
    const before = store.getSnapshot();
    const anna = await store.addSignedIn(DEV_WORLD, viewer('v-anna', 'anna'), tokens(1));
    store.setActive(anna.id);
    store.update(anna.id, { mustChangePassword: true });
    expect(listener).toHaveBeenCalledTimes(3);
    expect(store.getSnapshot()).not.toBe(before);
    unsubscribe();
    store.setActive(null);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('survives corrupt or foreign storage content', () => {
    const { storage, vault } = setup();
    storage.map.set('accounts', '{not json');
    storage.map.set('active', 'ghost');
    expect(new AccountStore({ storage, vault }).getSnapshot()).toEqual({
      accounts: [],
      activeId: null,
    });
    storage.map.set('accounts', JSON.stringify([{ id: 1 }, { hello: 'world' }]));
    expect(new AccountStore({ storage, vault }).getSnapshot().accounts).toEqual([]);
    expect(parseTokens('{"accessToken":1}')).toBeNull();
    expect(parseTokens(undefined)).toBeNull();
  });

  it('a second sign-out keeps the first reason and reports nothing again', async () => {
    const { store } = setup();
    const ended = jest.fn();
    store.onSessionEnded(ended);
    const anna = await store.addSignedIn(DEV_WORLD, viewer('v-anna', 'anna'), tokens(1));
    await store.signOut(anna.id, 'refresh_token_reused');
    const listener = jest.fn();
    store.subscribe(listener);
    await store.signOut(anna.id, 'session_ended');
    expect(store.get(anna.id)).toMatchObject({
      signedIn: false,
      endedReason: 'refresh_token_reused',
    });
    expect(ended).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();
  });

  it('re-reads the vault on demand (tokens rotated by another tab)', async () => {
    const { store, vault } = setup();
    const anna = await store.addSignedIn(DEV_WORLD, viewer('v-anna', 'anna'), tokens(1));
    await vault.set(anna.id, tokens(7));
    await expect(store.readTokens(anna.id)).resolves.toEqual(tokens(1));
    await expect(store.readTokens(anna.id, true)).resolves.toEqual(tokens(7));
    await expect(store.readTokens(anna.id)).resolves.toEqual(tokens(7));
  });
});

describe('AccountStore in several browser tabs (one shared storage)', () => {
  function browser() {
    const storage = memoryStorage();
    const vault = createMemoryVault();
    let n = 0;
    const open = (tab?: KeyValueStorage) =>
      new AccountStore({ storage, vault, tabStorage: tab, newId: () => `acc${(n += 1)}` });
    return { storage, vault, open };
  }

  const usernames = (store: AccountStore) =>
    store.getSnapshot().accounts.map((account) => account.username);

  it('a stale tab neither drops nor resurrects profiles another tab changed', async () => {
    const { vault, open } = browser();
    const tabA = open();
    await tabA.addSignedIn(DEV_WORLD, viewer('v-anna', 'anna'), tokens(1));
    const ben = await tabA.addSignedIn(DEV_WORLD, viewer('v-ben', 'ben'), tokens(2));
    const tabB = open();
    const gast = await tabA.addSignedIn(DEV_WORLD, viewer('v-gast', 'gast'), tokens(3));

    // Tab B still holds [anna, ben] in memory.
    await tabB.remove(ben.id);
    expect(usernames(open())).toEqual(['anna', 'gast']);
    expect(usernames(tabB)).toEqual(['anna', 'gast']);
    expect(vault.entries.get(gast.id)).toEqual(tokens(3));

    // Tab A still holds [anna, ben, gast] in memory.
    await tabA.signOut(gast.id);
    expect(usernames(open())).toEqual(['anna', 'gast']);
    expect(open().get(gast.id)).toMatchObject({ signedIn: false });
    expect(usernames(tabA)).toEqual(['anna', 'gast']);
    expect(vault.entries.has(gast.id)).toBe(false);
  });

  it("a stale tab's own writes keep another tab's display name edit", async () => {
    const { open } = browser();
    const tabA = open();
    const anna = await tabA.addSignedIn(DEV_WORLD, viewer('v-anna', 'anna'), tokens(1));
    const ben = await tabA.addSignedIn(DEV_WORLD, viewer('v-ben', 'ben'), tokens(2));
    const tabB = open();
    tabA.update(anna.id, { displayName: 'Anna B.' });
    tabB.setActive(ben.id);
    tabB.update(ben.id, { mustChangePassword: true });
    expect(tabB.get(anna.id)?.displayName).toBe('Anna B.');
    tabA.reload();
    expect(tabA.get(anna.id)?.displayName).toBe('Anna B.');
    expect(tabA.get(ben.id)?.mustChangePassword).toBe(true);
  });

  it('profiles added in two tabs both stay', async () => {
    const { open } = browser();
    const tabA = open();
    await tabA.addSignedIn(DEV_WORLD, viewer('v-anna', 'anna'), tokens(1));
    const tabB = open();
    await tabA.addSignedIn(DEV_WORLD, viewer('v-gast', 'gast'), tokens(2));
    await tabB.addSignedIn(DEV_WORLD, viewer('v-kind', 'kind'), tokens(3));
    expect(usernames(open())).toEqual(['anna', 'gast', 'kind']);
  });

  it('a session ended in another tab is not ended (or reported) again here', async () => {
    const { open } = browser();
    const tabA = open();
    const anna = await tabA.addSignedIn(DEV_WORLD, viewer('v-anna', 'anna'), tokens(1));
    const tabB = open();
    const ended = jest.fn();
    tabB.onSessionEnded(ended);
    await tabA.signOut(anna.id, 'refresh_token_reused');
    await tabB.signOut(anna.id, 'session_ended');
    expect(open().get(anna.id)).toMatchObject({ endedReason: 'refresh_token_reused' });
    expect(tabB.get(anna.id)).toMatchObject({ endedReason: 'refresh_token_reused' });
    expect(ended).not.toHaveBeenCalled();
  });

  it('each tab keeps its own active profile, also across a reload of that tab', async () => {
    const { open } = browser();
    const session = new Map<string, string>();
    const tabStorage = tabSessionStorage({
      getItem: (key) => session.get(key) ?? null,
      setItem: (key, value) => void session.set(key, value),
      removeItem: (key) => void session.delete(key),
    });
    const tabA = open(tabStorage);
    const anna = await tabA.addSignedIn(DEV_WORLD, viewer('v-anna', 'anna'), tokens(1));
    const ben = await tabA.addSignedIn(DEV_WORLD, viewer('v-ben', 'ben'), tokens(2));
    tabA.setActive(anna.id);
    const tabB = open(memoryStorage());
    tabB.setActive(ben.id);

    tabA.reload();
    expect(tabA.getSnapshot().activeId).toBe(anna.id);
    expect(open(tabStorage).getSnapshot().activeId).toBe(anna.id);
    // A new tab offers the profile used last.
    expect(open().getSnapshot().activeId).toBe(ben.id);

    await tabB.remove(anna.id);
    tabA.reload();
    expect(tabA.getSnapshot().activeId).toBeNull();
    expect(open(tabStorage).getSnapshot().activeId).toBe(ben.id);
  });

  it('follows storage events: list changes reach subscribers, rotated tokens are re-read', async () => {
    const { open } = browser();
    const tabA = open();
    const anna = await tabA.addSignedIn(DEV_WORLD, viewer('v-anna', 'anna'), tokens(1));
    const tabB = open();
    await expect(tabB.readTokens(anna.id)).resolves.toEqual(tokens(1));

    const handlers = new Set<(event: { key: string | null }) => void>();
    const window: StorageEventTarget = {
      addEventListener: (_type, handler) => void handlers.add(handler),
      removeEventListener: (_type, handler) => void handlers.delete(handler),
    };
    const emit = (key: string | null) => handlers.forEach((handler) => handler({ key }));
    const stop = followOtherTabs(tabB, window);
    const listener = jest.fn();
    tabB.subscribe(listener);

    await tabA.addSignedIn(DEV_WORLD, viewer('v-ben', 'ben'), tokens(2));
    emit('streamarr.accounts\\accounts');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(usernames(tabB)).toEqual(['anna', 'ben']);

    await tabA.writeTokens(anna.id, tokens(7));
    emit(`streamarr.vault\\${anna.id}`);
    await expect(tabB.readTokens(anna.id)).resolves.toEqual(tokens(7));

    emit('streamarr.cache.x\\q-discover');
    emit('streamarr.accounts\\active');
    expect(listener).toHaveBeenCalledTimes(1);

    stop();
    expect(handlers.size).toBe(0);
  });
});
