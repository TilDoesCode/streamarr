import { Platform } from 'react-native';

import { claimMenu } from '@/components/focus';
import { Dialog } from '@/components/ui/dialog';
import { Sheet, SheetItem } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import '@/i18n';
import { renderWithProviders } from '@/../jest/render';

const mockSetMenuMode = jest.fn();
jest.mock('@modules/tv-native', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    tvNativeAvailable: true,
    TVFocusHost: View,
    setMenuMode: (mode: string | null) => mockSetMenuMode(mode),
    resetMenu: () => undefined,
    lastMenuInTabBar: () => false,
    focusView: () => null,
  };
});
jest.mock('react-native/Libraries/Components/View/ViewNativeComponent', () => ({
  ...jest.requireActual('@react-native/jest-preset/jest/mocks/ViewNativeComponent'),
  Commands: { setDestinations: jest.fn(), requestTVFocus: jest.fn() },
}));

const os = Platform.OS;
let releasePage: () => void;
beforeEach(() => {
  Platform.OS = 'ios';
  jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
  // The page under the modal claims Menu (e.g. the player or the library grid).
  releasePage = claimMenu('always');
  mockSetMenuMode.mockClear();
});
afterEach(() => {
  releasePage();
  Platform.OS = os;
  jest.restoreAllMocks();
});

describe('Apple TV RN Modals keep Menu for their own recogniser (I4 review M12)', () => {
  it('Sheet switches the page claim off while open and gives it back when closed', async () => {
    const sheet = (open: boolean) => (
      <Sheet open={open} onClose={() => undefined} title="Sort">
        <SheetItem label="A-Z" onPress={() => undefined} />
      </Sheet>
    );
    const view = await renderWithProviders(sheet(true));
    expect(mockSetMenuMode).toHaveBeenLastCalledWith(null);
    await view.unmount();
    expect(mockSetMenuMode).toHaveBeenLastCalledWith('always');
  });

  it('Dialog switches the page claim off while open and gives it back when closed', async () => {
    const dialog = (open: boolean) => (
      <Dialog
        open={open}
        onClose={() => undefined}
        title="Remove?"
        actions={[{ label: 'OK', onPress: () => undefined }]}>
        <Text>body</Text>
      </Dialog>
    );
    const view = await renderWithProviders(dialog(true));
    expect(mockSetMenuMode).toHaveBeenLastCalledWith(null);
    await view.rerender(dialog(false));
    expect(mockSetMenuMode).toHaveBeenLastCalledWith('always');
  });
});
