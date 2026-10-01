import { render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { isLargeShell } from '@/shell/shell-metrics';
import { detectFormFactor } from '@/theme/form-factor';

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

describe('AppTabs resize / split screen', () => {
  it.each([
    [true, false, 'large-shell', 'native-tabs'],
    [false, true, 'native-tabs', 'large-shell'],
  ])('follows the live form factor: large %s -> %s', async (from, to, before, after) => {
    setPlatform('android', false);
    mockLarge = from;
    const view = await render(<AppTabs />);
    expect(screen.getByText(before)).toBeTruthy();
    mockLarge = to;
    await view.rerender(<AppTabs />);
    expect(screen.getByText(after)).toBeTruthy();
    expect(screen.queryByText(before)).toBeNull();
  });

  it('keeps Apple TV on native tabs whatever the size', async () => {
    setPlatform('ios', true);
    mockLarge = true;
    const view = await render(<AppTabs />);
    mockLarge = false;
    await view.rerender(<AppTabs />);
    expect(screen.getByText('native-tabs')).toBeTruthy();
  });
});

describe('shell selection at the resize boundaries', () => {
  const base = { isTV: false, isPad: false, finePointer: true };
  it.each([
    ['android tablet full screen', { os: 'android', width: 1280, height: 800 }, true],
    ['android split screen 599 dp', { os: 'android', width: 599, height: 800 }, false],
    ['android split screen 600 dp', { os: 'android', width: 600, height: 800 }, true],
    ['web 639 px', { os: 'web', width: 639, height: 900 }, false],
    ['web 640 px', { os: 'web', width: 640, height: 900 }, true],
  ])('%s -> large %s', (_, input, large) => {
    expect(isLargeShell(detectFormFactor({ ...base, ...input }))).toBe(large);
  });
});
