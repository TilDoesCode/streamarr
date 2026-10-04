import { render } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { BackHandler, Platform } from 'react-native';

const mockSetMenuMode = jest.fn();
const mockNavigate = jest.fn();
let mockPath = '/';

let mockMode: string | null = 'tabBar';
jest.mock('@/components/focus/tv-menu', () => ({
  ...jest.requireActual('@/components/focus/tv-menu'),
  currentMenuMode: () => mockMode,
}));
jest.mock('@modules/tv-native', () => ({
  tvNativeAvailable: true,
  setMenuMode: (mode: string | null) => mockSetMenuMode(mode),
}));
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  usePathname: () => mockPath,
  useRouter: () => ({ navigate: mockNavigate }),
}));
jest.mock('expo-router/unstable-native-tabs', () => {
  function Trigger({ children }: { children?: ReactNode }) {
    return <>{children}</>;
  }
  Trigger.Icon = function Icon() {
    return null;
  };
  Trigger.Label = function Label() {
    return null;
  };
  function Tabs({ children }: { children?: ReactNode }) {
    return <>{children}</>;
  }
  return { NativeTabs: Object.assign(Tabs, { Trigger }) };
});

const handlers: ((event: never) => boolean | null | undefined)[] = [];
const os = Platform.OS;
beforeAll(() => {
  Platform.OS = 'ios';
  jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, handler) => {
    handlers.push(handler);
    return { remove: () => handlers.splice(handlers.indexOf(handler), 1) };
  });
});
afterAll(() => {
  Platform.OS = os;
  jest.restoreAllMocks();
});
beforeEach(() => {
  mockSetMenuMode.mockClear();
  mockNavigate.mockClear();
});

const pressMenu = () => [...handlers].reverse().some((handler) => handler({} as never));

// Required after the platform is Apple TV: the shell reads it once at import.
const renderShell = () => {
  const { NativeTabsShell } =
    jest.requireActual<typeof import('./native-tabs-shell')>('./native-tabs-shell');
  return render(<NativeTabsShell />);
};

describe('NativeTabsShell on Apple TV (I4 item 3: Menu goes to Start first)', () => {
  it.each(['/movies', '/series', '/search', '/settings'])(
    'claims Menu while the tab bar holds focus on %s and returns to Start',
    async (path) => {
      mockPath = path;
      const view = await renderShell();
      expect(mockSetMenuMode).toHaveBeenLastCalledWith('tabBar');
      expect(pressMenu()).toBe(true);
      expect(mockNavigate).toHaveBeenCalledWith('/');
      await view.unmount();
    }
  );

  it('leaves Menu to a page step that claims it more strongly (library grid)', async () => {
    mockPath = '/movies';
    mockMode = 'always';
    const view = await renderShell();
    expect(pressMenu()).toBe(false);
    expect(mockNavigate).not.toHaveBeenCalled();
    mockMode = 'tabBar';
    await view.unmount();
  });

  it('leaves Menu on Start and inside a tab stack to tvOS', async () => {
    for (const path of ['/', '/movie/123']) {
      mockPath = path;
      const view = await renderShell();
      expect(mockSetMenuMode).not.toHaveBeenCalledWith('tabBar');
      pressMenu();
      expect(mockNavigate).not.toHaveBeenCalled();
      await view.unmount();
    }
  });
});
