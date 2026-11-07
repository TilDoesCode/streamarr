import { screen } from '@testing-library/react-native';
import { Platform, Text } from 'react-native';

import { renderWithProviders } from '@/../jest/render';
import { StatusBarScrimLayer } from '@/shell/status-bar-scrim-layer';

let mockWindow: { width: number; height: number; scale: number; fontScale: number } | undefined;
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => {
  const actual = jest.requireActual('react-native/Libraries/Utilities/useWindowDimensions');
  return { __esModule: true, default: () => mockWindow ?? actual.default() };
});
const PHONE = { width: 390, height: 844, scale: 3, fontScale: 1 };
const TABLET = { width: 1024, height: 1366, scale: 2, fontScale: 1 };

afterEach(() => {
  mockWindow = undefined;
  jest.restoreAllMocks();
});

const page = () =>
  renderWithProviders(
    <StatusBarScrimLayer testID="page-status-scrim">
      <Text testID="page">Page</Text>
    </StatusBarScrimLayer>
  );

describe('status bar scrim over edge-to-edge pages', () => {
  it('Android phone: the page gets the scrim on top, above its content', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    mockWindow = PHONE;
    await page();
    const scrim = screen.getByTestId('page-status-scrim');
    expect(scrim).toHaveStyle({ position: 'absolute', top: 0, left: 0, right: 0 });
    // Scrim and page share one full-size layer, the scrim drawn last (on top).
    const layer = screen.getByTestId('page').parent!;
    expect(layer).toHaveStyle({ flex: 1 });
    expect(layer.children.at(-1)).toBe(scrim);
  });

  it.each([
    ['iOS phone (UIKit adopts the list for its scroll-edge effect)', 'ios', PHONE],
    ['Android tablet (large shell)', 'android', TABLET],
  ] as const)('%s: no scrim, the page as it is', async (_, os, window) => {
    jest.replaceProperty(Platform, 'OS', os);
    mockWindow = window;
    await page();
    expect(screen.queryByTestId('page-status-scrim')).toBeNull();
    expect(screen.getByTestId('page').parent).not.toHaveStyle({ flex: 1 });
  });
});
