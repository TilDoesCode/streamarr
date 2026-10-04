import { render } from '@testing-library/react-native';
import { createRef } from 'react';
import { BackHandler, Platform, View } from 'react-native';

const mockNative = {
  setMenuMode: jest.fn(),
  resetMenu: jest.fn(),
  lastMenuInTabBar: jest.fn(() => false),
  focusView: jest.fn((_tag: number) => Promise.resolve('focused') as Promise<string> | null),
};

jest.mock('@modules/tv-native', () => {
  const { View: MockView } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    tvNativeAvailable: true,
    TVFocusHost: MockView,
    setMenuMode: (mode: string | null) => mockNative.setMenuMode(mode),
    resetMenu: () => mockNative.resetMenu(),
    lastMenuInTabBar: () => mockNative.lastMenuInTabBar(),
    focusView: (tag: number) => mockNative.focusView(tag),
  };
});

jest.mock('react-native/Libraries/ReactNative/RendererProxy', () => ({
  ...jest.requireActual('react-native/Libraries/ReactNative/RendererProxy'),
  findNodeHandle: () => 42,
}));

const os = Platform.OS;
function platform(kind: 'appleTV' | 'androidTV' | 'iPhone') {
  Platform.OS = kind === 'androidTV' ? 'android' : 'ios';
  jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(kind !== 'iPhone');
}

/** A fresh module registry that shares this file's React and React Native (hooks, Platform, BackHandler). */
function isolate(run: () => void) {
  const react = jest.requireActual('react');
  const reactNative = jest.requireActual('react-native');
  // React Native's lazy getters would require fresh Platform/BackHandler copies inside the isolated registry.
  const shared = Object.create(reactNative, {
    Platform: { value: reactNative.Platform },
    BackHandler: { value: reactNative.BackHandler },
  });
  jest.isolateModules(() => {
    jest.doMock('react', () => react);
    jest.doMock('react-native', () => shared);
    run();
  });
}

type Menu = typeof import('../focus/tv-menu');
type Focus = typeof import('../focus/tv-focus');

/** Fresh modules per test: the Menu safety net registers once at import, on Apple TV only. */
function load(kind: 'appleTV' | 'androidTV' | 'iPhone') {
  platform(kind);
  const listeners: ((event: never) => boolean | null | undefined)[] = [];
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, handler) => {
    listeners.push(handler);
    return { remove: () => listeners.splice(listeners.indexOf(handler), 1) };
  });
  let menu!: Menu;
  let focus!: Focus;
  isolate(() => {
    menu = jest.requireActual('../focus/tv-menu');
    focus = jest.requireActual('../focus/tv-focus');
  });
  // BackHandler calls the newest listener first and stops at the first true.
  const pressMenu = () => [...listeners].reverse().some((listener) => listener({} as never));
  return { menu, focus, listeners, pressMenu };
}

beforeEach(() => {
  Object.values(mockNative).forEach((fn) => fn.mockClear());
});

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
afterEach(() => {
  Platform.OS = os;
  jest.restoreAllMocks();
});

describe('Apple TV Menu claims (I4 primitive A)', () => {
  it('arms the native gate with the strongest claim and restores it on release', async () => {
    const { menu } = load('appleTV');
    const releaseTabBar = menu.claimMenu('tabBar');
    expect(mockNative.setMenuMode).toHaveBeenLastCalledWith('tabBar');
    const releaseSheet = menu.claimMenu('always');
    expect(mockNative.setMenuMode).toHaveBeenLastCalledWith('always');
    releaseSheet();
    expect(mockNative.setMenuMode).toHaveBeenLastCalledWith('tabBar');
    releaseTabBar();
    expect(mockNative.setMenuMode).toHaveBeenLastCalledWith(null);
  });

  it('keeps the gate off while an RN Modal (own Menu recogniser) is open', async () => {
    const { menu } = load('appleTV');
    menu.claimMenu('always');
    const releaseModal = menu.claimMenu('native');
    expect(mockNative.setMenuMode).toHaveBeenLastCalledWith(null);
    releaseModal();
    expect(mockNative.setMenuMode).toHaveBeenLastCalledWith('always');
  });

  it('lets the next Menu go to tvOS when a claimed one reached no handler', async () => {
    const { menu, pressMenu } = load('appleTV');
    menu.claimMenu('always');
    expect(pressMenu()).toBe(false);
    expect(menu.currentMenuMode()).toBeNull();
    expect(mockNative.setMenuMode).toHaveBeenLastCalledWith(null);
    // The next claim change re-arms it (the strongest claim still decides).
    menu.claimMenu('tabBar');
    expect(menu.currentMenuMode()).toBe('always');
  });

  it('switches a stale native gate off at start and on every unhandled Menu (JS reload)', async () => {
    const { pressMenu } = load('appleTV');
    expect(mockNative.resetMenu).toHaveBeenCalledTimes(1);
    mockNative.setMenuMode.mockClear();
    // No claim in this bundle, but the native gate may still be armed from the previous one.
    expect(pressMenu()).toBe(false);
    expect(mockNative.setMenuMode).toHaveBeenLastCalledWith(null);
  });

  it('ignores a stale tab-bar flag when Menu came through an RN Modal, not the gate (V1 leftover)', async () => {
    const { menu } = load('appleTV');
    // The last press through the armed gate came from the tab bar; the native side keeps that value.
    mockNative.lastMenuInTabBar.mockReturnValue(true);
    const releaseTab = menu.claimMenu('tabBar');
    expect(menu.menuPressInTabBar()).toBe(true);
    const releaseModal = menu.claimMenu('native');
    expect(menu.menuPressInTabBar()).toBe(false);
    releaseModal();
    releaseTab();
    expect(menu.menuPressInTabBar()).toBe(false);
    mockNative.lastMenuInTabBar.mockReturnValue(false);
  });

  it('has no dev-only observe claim (V1 leftover)', () => {
    // Type-level: tsc fails while 'observe' is still a claim.
    const never = (menu: Menu) => {
      // @ts-expect-error observe is a removed dev probe mode
      menu.claimMenu('observe');
    };
    expect(typeof never).toBe('function');
  });

  it('runs below every screen handler: a handled Menu keeps the claim', async () => {
    const { menu, listeners, pressMenu } = load('appleTV');
    menu.claimMenu('always');
    listeners.push(() => true);
    expect(pressMenu()).toBe(true);
    expect(menu.currentMenuMode()).toBe('always');
  });

  it.each(['androidTV', 'iPhone'] as const)('does nothing on %s', async (kind) => {
    const { menu, listeners } = load(kind);
    function Claim() {
      menu.useMenuClaim('always');
      return null;
    }
    await render(<Claim />);
    expect(listeners).toHaveLength(0);
    expect(mockNative.setMenuMode).not.toHaveBeenCalled();
  });

  it('useMenuClaim claims while mounted and releases on unmount', async () => {
    const { menu } = load('appleTV');
    function Claim({ mode }: { mode: 'always' | null }) {
      menu.useMenuClaim(mode);
      return null;
    }
    const screen = await render(<Claim mode="always" />);
    expect(mockNative.setMenuMode).toHaveBeenLastCalledWith('always');
    await screen.rerender(<Claim mode={null} />);
    expect(mockNative.setMenuMode).toHaveBeenLastCalledWith(null);
  });
});

describe('Apple TV focus requests (I4 primitive B)', () => {
  it('asks the focus system through the module on Apple TV', async () => {
    const { focus } = load('appleTV');
    const requestTVFocus = jest.fn();
    focus.tvFocus({ requestTVFocus });
    expect(mockNative.focusView).toHaveBeenCalledWith(42);
    expect(requestTVFocus).not.toHaveBeenCalled();
  });

  it('falls back to requestTVFocus when the module could not focus the view', async () => {
    const { focus } = load('appleTV');
    mockNative.focusView.mockReturnValueOnce(Promise.resolve('missed'));
    const requestTVFocus = jest.fn();
    focus.tvFocus({ requestTVFocus });
    await Promise.resolve();
    await Promise.resolve();
    expect(requestTVFocus).toHaveBeenCalledTimes(1);
  });

  it('leaves focus alone when the request was cancelled (a newer one or the user moved)', async () => {
    const { focus } = load('appleTV');
    mockNative.focusView.mockReturnValueOnce(Promise.resolve('cancelled'));
    const requestTVFocus = jest.fn();
    focus.tvFocus({ requestTVFocus });
    await flush();
    expect(requestTVFocus).not.toHaveBeenCalled();
  });

  it('never falls back to an older target once a newer request started', async () => {
    const { focus } = load('appleTV');
    let missOld!: (result: string) => void;
    mockNative.focusView.mockReturnValueOnce(new Promise((resolve) => (missOld = resolve)));
    const seekBar = { requestTVFocus: jest.fn() };
    const play = { requestTVFocus: jest.fn() };
    focus.tvFocus(seekBar);
    focus.tvFocus(play);
    missOld('missed');
    await flush();
    expect(seekBar.requestTVFocus).not.toHaveBeenCalled();
  });

  it('falls back after the bound when the native request never settles', async () => {
    jest.useFakeTimers();
    const { focus } = load('appleTV');
    mockNative.focusView.mockReturnValueOnce(new Promise(() => undefined));
    const requestTVFocus = jest.fn();
    focus.tvFocus({ requestTVFocus });
    jest.advanceTimersByTime(focus.NATIVE_FOCUS_TIMEOUT_MS);
    await flush();
    expect(requestTVFocus).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it.each(['androidTV', 'iPhone'] as const)('keeps requestTVFocus on %s', async (kind) => {
    const { focus } = load(kind);
    const requestTVFocus = jest.fn();
    focus.tvFocus({ requestTVFocus });
    expect(requestTVFocus).toHaveBeenCalledTimes(1);
    expect(mockNative.focusView).not.toHaveBeenCalled();
  });

  it('focuses the main button once per mounted node on Apple TV and forwards the ref', async () => {
    const { focus } = load('appleTV');
    jest.spyOn(global, 'requestAnimationFrame').mockImplementation((run) => {
      run(0);
      return 0;
    });
    const forwarded = createRef<View>();
    const node = { requestTVFocus: jest.fn() } as unknown as View;
    let attach!: (node: View | null) => void;
    function Main() {
      attach = focus.useTvPreferredFocus(true, forwarded);
      return null;
    }
    await render(<Main />);
    attach(node);
    attach(node);
    expect(forwarded.current).toBe(node);
    expect(mockNative.focusView).toHaveBeenCalledTimes(1);
  });

  it('leaves the main button to hasTVPreferredFocus on Android TV', async () => {
    const { focus } = load('androidTV');
    let attach!: (node: View | null) => void;
    function Main() {
      attach = focus.useTvPreferredFocus(true);
      return null;
    }
    await render(<Main />);
    attach({ requestTVFocus: jest.fn() } as unknown as View);
    expect(mockNative.focusView).not.toHaveBeenCalled();
  });
});
