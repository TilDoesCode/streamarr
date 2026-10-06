import { render } from '@testing-library/react-native';
import { BackHandler, Platform } from 'react-native';

import { BACK_CONFIRM_MS, leavePlayer, recoveryBack, usePlayerBack } from '../player-tv-back';

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

  it('during a running recovery the first Menu only dismisses the hint, the next one leaves (S6u live)', () => {
    const now = 100_000;
    expect(recoveryBack(true, 0, now)).toBe('dismiss');
    expect(recoveryBack(true, now - 1_000, now)).toBe('leave');
    expect(recoveryBack(true, now - BACK_CONFIRM_MS - 1, now)).toBe('dismiss');
    expect(recoveryBack(false, 0, now)).toBe('leave');
  });
});

describe('leaving a player that was opened by a deep link (S9b2 end card)', () => {
  const router = (canGoBack: boolean) => ({
    canGoBack: () => canGoBack,
    back: jest.fn(),
    replace: jest.fn(),
  });
  const detail = { pathname: '/movie/[id]', params: { id: '45745' } } as never;

  it('with no screen below, Close and "Back to details" open the title\'s detail instead of doing nothing', () => {
    const lone = router(true);
    leavePlayer(lone, { detail, opener: undefined });
    expect(lone.back).not.toHaveBeenCalled();
    expect(lone.replace).toHaveBeenCalledWith(detail);
  });

  it('a screen below (the detail or a list) is where Close goes back to', () => {
    const below = router(true);
    leavePlayer(below, { detail, opener: { name: 'movie/[id]', params: { id: '45745' } } });
    expect(below.back).toHaveBeenCalled();
    expect(below.replace).not.toHaveBeenCalled();
  });

  it('nothing to go back to and no detail: home', () => {
    const nothing = router(false);
    leavePlayer(nothing, { detail: undefined, opener: undefined });
    expect(nothing.replace).toHaveBeenCalledWith('/');
  });
});
