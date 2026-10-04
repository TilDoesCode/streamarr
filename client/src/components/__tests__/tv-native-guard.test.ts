import { Platform } from 'react-native';

// The real modules/tv-native wrapper; only the native lookup is faked, so the Apple TV guard itself is under test.
const mockFake = {
  setMenuMode: jest.fn(),
  resetMenu: jest.fn(),
  lastMenuInTabBar: jest.fn(() => true),
  focus: jest.fn(async () => 'focused'),
  popToScreen: jest.fn(async () => true),
};
const mockLookup = jest.fn(() => mockFake);
jest.mock('expo', () => ({
  ...jest.requireActual('expo'),
  requireOptionalNativeModule: () => mockLookup(),
  requireNativeView: () => () => null,
}));

type Wrapper = typeof import('@modules/tv-native');
const os = Platform.OS;

function load(kind: 'appleTV' | 'androidTV' | 'iPhone' | 'web'): Wrapper {
  Platform.OS = kind === 'androidTV' ? 'android' : kind === 'web' ? 'web' : 'ios';
  jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(kind === 'appleTV' || kind === 'androidTV');
  let wrapper!: Wrapper;
  const reactNative = jest.requireActual('react-native');
  const shared = Object.create(reactNative, { Platform: { value: reactNative.Platform } });
  jest.isolateModules(() => {
    jest.doMock('react-native', () => shared);
    wrapper = jest.requireActual('@modules/tv-native');
  });
  return wrapper;
}

beforeEach(() => {
  mockLookup.mockClear();
  Object.values(mockFake).forEach((fn) => fn.mockClear());
});
afterEach(() => {
  Platform.OS = os;
  jest.restoreAllMocks();
});

describe('modules/tv-native Apple TV guard (I4 review)', () => {
  it.each(['androidTV', 'iPhone', 'web'] as const)('is a no-op on %s', async (kind) => {
    const tv = load(kind);
    expect(mockLookup).not.toHaveBeenCalled();
    expect(tv.tvNativeAvailable).toBe(false);
    tv.setMenuMode('always');
    tv.resetMenu();
    expect(tv.lastMenuInTabBar()).toBe(false);
    expect(tv.focusView(1)).toBeNull();
    expect(tv.popToScreen('movie-screen-1', 1)).toBeNull();
    expect(mockFake.setMenuMode).not.toHaveBeenCalled();
  });

  it('talks to the native module on Apple TV', async () => {
    const tv = load('appleTV');
    expect(tv.tvNativeAvailable).toBe(true);
    tv.setMenuMode('always');
    expect(mockFake.setMenuMode).toHaveBeenCalledWith('always');
    expect(tv.lastMenuInTabBar()).toBe(true);
    await expect(tv.focusView(1)).resolves.toBe('focused');
  });

  it('maps an older build boolean focus result to focused/missed', async () => {
    const tv = load('appleTV');
    mockFake.focus.mockResolvedValueOnce(false as never);
    await expect(tv.focusView(1)).resolves.toBe('missed');
  });
});
