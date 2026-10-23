import { act, renderHook } from '@testing-library/react-native';

import { deviceSettings } from '@/lib/storage';

import {
  readPerformancePreference,
  resolveLiteMode,
  usePerformancePreference,
  weakDeviceReason,
  writePerformancePreference,
} from '../performance-mode';

const TV = { os: 'android', isTV: true };
// ROCK 4D (Streamybox): Android 14, RK3576, 4–16 GB.
const rock4d = {
  socModel: 'RK3576',
  hardware: 'rk30board',
  boardPlatform: 'rk3576',
  totalMemoryMb: 7800,
  lowRam: false,
  cores: 8,
  maxCpuMhz: 2208,
  animatorScale: 1,
};
// A capable box (Shield-class): unknown SoC, plenty of RAM, fast cores.
const capable = {
  socModel: 'Tegra X1+',
  hardware: 'darcy',
  boardPlatform: 'tegra',
  totalMemoryMb: 3000,
  lowRam: false,
  cores: 4,
  maxCpuMhz: 2014,
  animatorScale: 1,
};

describe('weak device detection', () => {
  it('flags the ROCK 4D by its SoC, from SOC_MODEL or the board platform', () => {
    expect(weakDeviceReason(rock4d, TV)).toBe('soc');
    expect(weakDeviceReason({ ...rock4d, socModel: null }, TV)).toBe('soc');
    expect(weakDeviceReason({ hardware: 'rk3566' }, TV)).toBe('soc');
    expect(weakDeviceReason({ socModel: 'S905X4' }, TV)).toBe('soc');
  });

  it('flags low-RAM, small-memory and little-core-only TV boxes', () => {
    expect(weakDeviceReason({ ...capable, lowRam: true }, TV)).toBe('lowRam');
    expect(weakDeviceReason({ ...capable, totalMemoryMb: 1900 }, TV)).toBe('memory');
    expect(weakDeviceReason({ ...capable, maxCpuMhz: 1800 }, TV)).toBe('cpu');
  });

  it('keeps capable boxes, phones and missing facts on the full UI', () => {
    expect(weakDeviceReason(capable, TV)).toBeNull();
    expect(weakDeviceReason({}, TV)).toBeNull();
    expect(weakDeviceReason(rock4d, { os: 'android', isTV: false })).toBeNull();
    expect(weakDeviceReason(rock4d, { os: 'ios', isTV: true })).toBeNull();
  });

  it('respects removed system animations on every device', () => {
    expect(weakDeviceReason({ ...capable, animatorScale: 0 }, TV)).toBe('animationsOff');
    expect(weakDeviceReason({ animatorScale: 0 }, { os: 'android', isTV: false })).toBe(
      'animationsOff'
    );
    expect(weakDeviceReason({ animatorScale: 0.5 }, TV)).toBeNull();
  });

  it('auto follows the hardware, on/off override it', () => {
    expect(resolveLiteMode('auto', rock4d, TV)).toBe(true);
    expect(resolveLiteMode('auto', capable, TV)).toBe(false);
    expect(resolveLiteMode('off', rock4d, TV)).toBe(false);
    expect(resolveLiteMode('on', capable, TV)).toBe(true);
  });
});

describe('performance setting', () => {
  afterEach(() => writePerformancePreference('auto'));

  it('defaults to auto and persists per device in MMKV', () => {
    expect(readPerformancePreference()).toBe('auto');
    writePerformancePreference('on');
    expect(deviceSettings.getString('performanceMode')).toBe('on');
    expect(readPerformancePreference()).toBe('on');
    writePerformancePreference('auto');
    expect(deviceSettings.getString('performanceMode')).toBeUndefined();
  });

  it('ignores unknown stored values', () => {
    deviceSettings.set('performanceMode', 'turbo');
    expect(readPerformancePreference()).toBe('auto');
  });

  it('hooks follow a change made elsewhere', async () => {
    const { result } = await renderHook(() => usePerformancePreference());
    expect(result.current).toBe('auto');
    await act(async () => writePerformancePreference('off'));
    expect(result.current).toBe('off');
  });
});
