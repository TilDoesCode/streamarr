import { render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { AppTabs } from './app-tabs';

let mockLarge = false;
jest.mock('@/shell/use-shell', () => ({ useShell: () => ({ large: mockLarge }) }));
jest.mock('./large-shell', () => ({
  LargeShell: () => {
    const { Text: T } = jest.requireActual<typeof import('react-native')>('react-native');
    return <T>large-shell</T>;
  },
}));
jest.mock('./native-tabs-shell', () => ({
  NativeTabsShell: () => {
    const { Text: T } = jest.requireActual<typeof import('react-native')>('react-native');
    return <T>native-tabs</T>;
  },
}));

const setPlatform = (os: string, tv: boolean) => {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
  Object.defineProperty(Platform, 'isTV', { value: tv, configurable: true });
};

describe('AppTabs shell selection', () => {
  const os = Platform.OS;
  const tv = Platform.isTV;
  afterEach(() => setPlatform(os, tv));

  it.each([
    ['android', true, true, 'large-shell'],
    ['android', false, true, 'large-shell'],
    ['android', false, false, 'native-tabs'],
    ['ios', false, false, 'native-tabs'],
    ['ios', true, true, 'native-tabs'],
  ])('%s tv=%s large=%s -> %s', async (platform, isTV, isLarge, expected) => {
    setPlatform(platform, isTV);
    mockLarge = isLarge;
    await render(<AppTabs />);
    expect(screen.getByText(expected)).toBeTruthy();
  });
});
