import { Platform } from 'react-native';

import { deviceName, displayDeviceName, friendlyModel } from '../device';

describe('device names', () => {
  it('capitalises the manufacturer and names emulators', () => {
    expect(friendlyModel('google', 'sdk_google_atv64_amati_arm64')).toBe('Emulator');
    expect(friendlyModel('google', 'sdk_gphone64_arm64')).toBe('Emulator');
    expect(friendlyModel('google', 'Pixel 8')).toBe('Google Pixel 8');
    expect(friendlyModel('samsung', 'SM-S921B')).toBe('Samsung SM-S921B');
    expect(friendlyModel('OnePlus', 'OnePlus 9')).toBe('OnePlus 9');
    expect(friendlyModel('lge', 'LM-G900')).toBe('LG LM-G900');
    expect(friendlyModel(undefined, 'Shield')).toBe('Shield');
  });

  it('builds the Android name it sends at sign-in', () => {
    const os = Platform.OS;
    Platform.OS = 'android';
    const constants = jest
      .spyOn(Platform, 'constants', 'get')
      .mockReturnValue({ Brand: 'google', Model: 'Pixel 8' } as never);
    try {
      expect(deviceName()).toBe('Google Pixel 8 (Android)');
    } finally {
      constants.mockRestore();
      Platform.OS = os;
    }
  });

  it('formats stored raw names and drops unknown ones', () => {
    expect(displayDeviceName('google sdk_google_atv64_amati_arm64 (Android TV)')).toBe(
      'Emulator (Android TV)'
    );
    expect(displayDeviceName('samsung SM-S921B (Android)')).toBe('Samsung SM-S921B (Android)');
    expect(displayDeviceName('Chrome (Web)')).toBe('Chrome (Web)');
    expect(displayDeviceName('iPhone')).toBe('iPhone');
    expect(displayDeviceName(null)).toBeNull();
    expect(displayDeviceName('  ')).toBeNull();
    expect(displayDeviceName('Unknown device')).toBeNull();
  });
});
