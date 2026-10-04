import { screen } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { SheetPanel } from '@/browse/version-sheet';
import { Focusable } from '@/components/focus';
import { Text } from '@/components/ui/text';
import '@/i18n';
import { renderWithProviders } from '@/../jest/render';

const mockSetMenuMode = jest.fn();
jest.mock('@modules/tv-native', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    tvNativeAvailable: true,
    TVFocusHost: (props: object) => <View testID="tv-focus-host" {...props} />,
    setMenuMode: (mode: string | null) => mockSetMenuMode(mode),
    focusView: () => null,
  };
});

// RN's Jest mock of the native View lacks Commands; TVFocusGuideView sends setDestinations on TV.
jest.mock('react-native/Libraries/Components/View/ViewNativeComponent', () => ({
  ...jest.requireActual('@react-native/jest-preset/jest/mocks/ViewNativeComponent'),
  Commands: { setDestinations: jest.fn(), requestTVFocus: jest.fn() },
}));

const os = Platform.OS;
function platform(kind: 'appleTV' | 'androidTV') {
  Platform.OS = kind === 'appleTV' ? 'ios' : 'android';
  jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
}
beforeEach(() => mockSetMenuMode.mockClear());
afterEach(() => {
  Platform.OS = os;
  jest.restoreAllMocks();
});

const panel = (frame: 'tv' | 'drawer') => (
  <SheetPanel
    frame={frame}
    testID="versions"
    title="Versions"
    onClose={() => undefined}
    header={null}>
    <Focusable testID="card-last" onPress={() => undefined}>
      <Text>Last</Text>
    </Focusable>
  </SheetPanel>
);

describe('SheetPanel on TV (I4 item 7: last card glow)', () => {
  it('centres the focused card, so the last ring and glow clear the panel edge', async () => {
    platform('androidTV');
    await renderWithProviders(panel('tv'));
    expect(screen.getByTestId('versions-list')).toHaveProp('snapToAlignment', 'item');
    expect(screen.getByTestId('card-last')).toHaveProp('scrollSnapAlign', 'center');
  });

  it('leaves the drawer (web, tablets) scrolling as before', async () => {
    Platform.OS = 'ios';
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(false);
    await renderWithProviders(panel('drawer'));
    expect(screen.getByTestId('versions-list')).not.toHaveProp('snapToAlignment', 'item');
    expect(screen.getByTestId('card-last')).not.toHaveProp('scrollSnapAlign', 'center');
  });
});

describe('SheetPanel on Apple TV (I4 items 1 and 2)', () => {
  it('takes Menu while open and gives it back when closed', async () => {
    platform('appleTV');
    const view = await renderWithProviders(panel('tv'));
    expect(mockSetMenuMode).toHaveBeenLastCalledWith('always');
    await view.unmount();
    expect(mockSetMenuMode).toHaveBeenLastCalledWith(null);
  });

  it('hosts the panel in a focus host, so initial focus resolves inside the presented sheet', async () => {
    platform('appleTV');
    await renderWithProviders(panel('tv'));
    expect(screen.getByTestId('tv-focus-host')).toBeTruthy();
  });

  it('claims nothing on Android TV', async () => {
    platform('androidTV');
    await renderWithProviders(panel('tv'));
    expect(mockSetMenuMode).not.toHaveBeenCalled();
  });
});
