import { act, render } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createTabGuard,
  isPlayingHere,
  openTabChannel,
  useOneTabPlays,
  type TabChannel,
  type TabMessage,
} from '@/player/tab-guard';

/** One browser: every tab's channel reaches every other tab (like BroadcastChannel, never the sender). */
function fakeBrowser() {
  const tabs = new Set<(message: TabMessage) => void>();
  const open = (): TabChannel => {
    let mine: ((message: TabMessage) => void) | null = null;
    return {
      post: (message) => [...tabs].filter((tab) => tab !== mine).forEach((tab) => tab(message)),
      listen: (listener) => {
        mine = listener;
        tabs.add(listener);
        return () => void tabs.delete(listener);
      },
      close: () => undefined,
    };
  };
  return { open, tabs };
}

describe('one playing tab per browser (F12)', () => {
  it('a start in tab B pauses tab A; tab B is never told about its own start', () => {
    const browser = fakeBrowser();
    const a = jest.fn();
    const b = jest.fn();
    const tabA = createTabGuard(browser.open(), a);
    const tabB = createTabGuard(browser.open(), b);
    tabA.announce();
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
    tabB.announce();
    expect(a).toHaveBeenCalledTimes(1);
    tabA.close();
    tabB.announce();
    expect(a).toHaveBeenCalledTimes(1);
  });

  it('the player announces each start and resume, and yields when another tab plays', async () => {
    const browser = fakeBrowser();
    const yielded = jest.fn();
    function Player({ playingHere }: { playingHere: boolean }) {
      useOneTabPlays(playingHere, yielded, browser.open);
      return null;
    }
    const other = jest.fn();
    createTabGuard(browser.open(), other);
    const view = await render(<Player playingHere={false} />);
    expect(other).not.toHaveBeenCalled();
    await view.rerender(<Player playingHere />);
    expect(other).toHaveBeenCalledTimes(1);
    await view.rerender(<Player playingHere={false} />);
    await view.rerender(<Player playingHere />);
    expect(other).toHaveBeenCalledTimes(2);
    await act(async () =>
      [...browser.tabs].forEach((tab) => tab({ type: 'playing', tab: 'elsewhere' }))
    );
    expect(yielded).toHaveBeenCalled();
    await act(async () => view.unmount());
    expect(browser.tabs.size).toBe(1);
  });

  it('a transport that echoes to the sender (polyfills, same-tab listeners) never pauses the tab that started', () => {
    const listeners = new Set<(message: TabMessage) => void>();
    const echoing: TabChannel = {
      post: (message) => listeners.forEach((listener) => listener(message)),
      listen: (listener) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      close: () => undefined,
    };
    const yielded = jest.fn();
    createTabGuard(echoing, yielded).announce();
    expect(yielded).not.toHaveBeenCalled();
  });

  it('native apps have no transport (one player per app)', () => {
    expect(openTabChannel()).toBeNull();
  });

  it('web: BroadcastChannel where the browser has it, else storage events (older Safari)', () => {
    const os = jest.replaceProperty(Platform, 'OS', 'web');
    const posted: unknown[] = [];
    class FakeBroadcastChannel {
      postMessage = (message: unknown) => posted.push(message);
      addEventListener = jest.fn();
      removeEventListener = jest.fn();
      close = jest.fn();
    }
    const original = (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = FakeBroadcastChannel;
    openTabChannel()?.post({ type: 'playing', tab: 'a' });
    expect(posted).toEqual([{ type: 'playing', tab: 'a' }]);
    delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
    const setItem = jest.fn();
    const storage = jest.replaceProperty(window, 'localStorage', { setItem } as never);
    const page = window as unknown as { addEventListener?: unknown };
    const listen = page.addEventListener;
    page.addEventListener = jest.fn();
    openTabChannel()?.post({ type: 'playing', tab: 'b' });
    expect(setItem).toHaveBeenCalledWith('streamarr.player', expect.stringContaining('"tab":"b"'));
    storage.restore();
    page.addEventListener = listen;
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = original;
    os.restore();
  });

  it('older Safari: the storage transport reads only its own key, skips foreign values and stops listening (verify B9)', () => {
    const os = jest.replaceProperty(Platform, 'OS', 'web');
    const original = (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
    delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
    const page = new EventTarget();
    const win = window as unknown as Record<string, unknown>;
    const saved = {
      addEventListener: win.addEventListener,
      removeEventListener: win.removeEventListener,
    };
    win.addEventListener = page.addEventListener.bind(page);
    win.removeEventListener = page.removeEventListener.bind(page);
    const storage = jest.replaceProperty(window, 'localStorage', { setItem: jest.fn() } as never);
    const storageEvent = (key: string, newValue: string | null) =>
      Object.assign(new Event('storage'), { key, newValue });
    const heard: TabMessage[] = [];
    const channel = openTabChannel()!;
    const off = channel.listen((message) => heard.push(message));
    page.dispatchEvent(
      storageEvent('streamarr.player', JSON.stringify({ type: 'playing', tab: 'b' }))
    );
    page.dispatchEvent(storageEvent('other.key', JSON.stringify({ type: 'playing', tab: 'c' })));
    page.dispatchEvent(storageEvent('streamarr.player', '{not json'));
    page.dispatchEvent(storageEvent('streamarr.player', null));
    expect(heard).toEqual([{ type: 'playing', tab: 'b' }]);
    off();
    page.dispatchEvent(
      storageEvent('streamarr.player', JSON.stringify({ type: 'playing', tab: 'd' }))
    );
    expect(heard).toHaveLength(1);
    storage.restore();
    win.addEventListener = saved.addEventListener;
    win.removeEventListener = saved.removeEventListener;
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = original;
    os.restore();
  });

  it('storage blocked (a throwing localStorage getter) means no guard, never a crash (F12-3)', () => {
    const os = jest.replaceProperty(Platform, 'OS', 'web');
    const original = (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
    delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw Object.assign(new Error('blocked'), { name: 'SecurityError' });
      },
    });
    try {
      expect(openTabChannel()).toBeNull();
    } finally {
      if (descriptor) Object.defineProperty(window, 'localStorage', descriptor);
      else delete (window as unknown as Record<string, unknown>).localStorage;
      (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = original;
      os.restore();
    }
  });

  it('the play screen announces exactly when this tab plays: playing and not paused (verify B8)', () => {
    expect(isPlayingHere({ phase: 'playing', paused: false })).toBe(true);
    expect(isPlayingHere({ phase: 'playing', paused: true })).toBe(false);
    expect(isPlayingHere({ phase: 'starting', paused: false })).toBe(false);
    expect(isPlayingHere(null)).toBe(false);
    const source = readFileSync(join(__dirname, '../../screens/player/play-screen.tsx'), 'utf8');
    expect(source).toMatch(/useOneTabPlays\(isPlayingHere\(controller\),/);
  });
});
