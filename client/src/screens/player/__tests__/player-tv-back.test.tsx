import { render } from '@testing-library/react-native';
import { BackHandler, Platform } from 'react-native';

import { leavePlayer, usePlayerBack } from '../player-tv-back';

const mockSetMenuMode = jest.fn();
const mockRequestReturnFocus = jest.fn();
const mockExpireReturnFocus = jest.fn();
jest.mock('@modules/tv-native', () => ({
  setMenuMode: (mode: string | null) => mockSetMenuMode(mode),
  resetMenu: () => undefined,
  lastMenuInTabBar: () => false,
}));
jest.mock('@/navigation/screen-focus', () => ({
  requestReturnFocus: () => mockRequestReturnFocus(),
  expireReturnFocus: () => mockExpireReturnFocus(),
}));

const os = Platform.OS;
beforeEach(() => {
  Platform.OS = 'ios';
  jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
  [mockSetMenuMode, mockRequestReturnFocus, mockExpireReturnFocus].forEach((fn) => fn.mockClear());
});
afterEach(() => {
  Platform.OS = os;
  jest.restoreAllMocks();
});

describe('player Back on Apple TV (I4 review M9, M10, item 9)', () => {
  it('claims Menu while the player is open and routes it to the player chain', async () => {
    const handlers: (() => boolean | null | undefined)[] = [];
    jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, handler) => {
      handlers.push(handler as () => boolean);
      return { remove: () => undefined };
    });
    const onBack = jest.fn(() => true);
    function Player() {
      usePlayerBack(onBack);
      return null;
    }
    const view = await render(<Player />);
    expect(mockSetMenuMode).toHaveBeenLastCalledWith('always');
    expect(handlers.at(-1)?.()).toBe(true);
    expect(onBack).toHaveBeenCalled();
    await view.unmount();
    expect(mockSetMenuMode).toHaveBeenLastCalledWith(null);
    expect(mockExpireReturnFocus).toHaveBeenCalledTimes(1);
  });

  it('asks the screen underneath to take its focus back when leaving', () => {
    const router = { canGoBack: () => true, back: jest.fn(), replace: jest.fn() };
    leavePlayer(router);
    expect(mockRequestReturnFocus).toHaveBeenCalledTimes(1);
    expect(router.back).toHaveBeenCalled();
    const lonely = { canGoBack: () => false, back: jest.fn(), replace: jest.fn() };
    leavePlayer(lonely);
    expect(lonely.replace).toHaveBeenCalledWith('/');
  });
});
