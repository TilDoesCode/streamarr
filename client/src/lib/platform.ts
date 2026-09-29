import { Platform } from 'react-native';

export type PlatformKey = 'androidtv' | 'appletv' | 'android' | 'ios' | 'web';

export function platformKey(): PlatformKey {
  if (Platform.OS === 'web') return 'web';
  if (Platform.isTV) return Platform.OS === 'ios' ? 'appletv' : 'androidtv';
  return Platform.OS === 'ios' ? 'ios' : 'android';
}
