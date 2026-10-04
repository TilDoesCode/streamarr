import { render } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { libraryBack, useLibraryMenuClaim, type LibraryZone } from '../library-back';

const mockSetMenuMode = jest.fn();
let mockFocused = true;
jest.mock('@modules/tv-native', () => ({
  setMenuMode: (mode: string | null) => mockSetMenuMode(mode),
  resetMenu: () => undefined,
  lastMenuInTabBar: () => false,
}));
jest.mock('expo-router', () => ({ useIsFocused: () => mockFocused }));

const os = Platform.OS;
beforeEach(() => {
  Platform.OS = 'ios';
  jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
  mockSetMenuMode.mockClear();
  mockFocused = true;
});
afterEach(() => {
  Platform.OS = os;
  jest.restoreAllMocks();
});

function Page({ zone }: { zone: LibraryZone }) {
  useLibraryMenuClaim(zone);
  return null;
}

describe('library Menu on Apple TV (I4 review M11 and risk 4)', () => {
  it('claims Menu for the grid only while the page is the visible screen', async () => {
    const view = await render(<Page zone="grid" />);
    expect(mockSetMenuMode).toHaveBeenLastCalledWith('always');
    mockFocused = false;
    await view.rerender(<Page zone="sort" />);
    expect(mockSetMenuMode).toHaveBeenLastCalledWith(null);
  });

  it('takes no page step when the Menu press came from the tab bar (Start comes first)', () => {
    expect(libraryBack('sort', true)).toEqual({ step: null, zone: 'sort' });
    expect(libraryBack('grid', true).step).toBeNull();
    expect(libraryBack('grid', false)).toEqual({ step: 'chip', zone: 'grid' });
  });
});
