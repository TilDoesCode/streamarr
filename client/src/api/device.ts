import Constants from 'expo-constants';
import { Platform } from 'react-native';

import { platformKey } from '@/lib/platform';

const PLATFORM_NAMES = {
  androidtv: 'Android TV',
  appletv: 'Apple TV',
  android: 'Android',
  ios: 'iOS',
  web: 'Web',
} as const;

function browserName(userAgent: string): string {
  if (/Edg\//.test(userAgent)) return 'Edge';
  if (/Firefox\//.test(userAgent)) return 'Firefox';
  if (/Chrome\//.test(userAgent)) return 'Chrome';
  if (/Safari\//.test(userAgent)) return 'Safari';
  return 'Browser';
}

/** Name the server shows in the viewer's device list (not UI copy: model or browser, not translated). */
export function deviceName(): string {
  if (Platform.OS === 'web') {
    const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
    return `${browserName(agent)} (${PLATFORM_NAMES.web})`;
  }
  if (Platform.OS === 'android') {
    const { Brand, Model } = Platform.constants as { Brand?: string; Model?: string };
    const model = [Brand, Model].filter(Boolean).join(' ');
    return model ? `${model} (${PLATFORM_NAMES[platformKey()]})` : PLATFORM_NAMES[platformKey()];
  }
  if (Platform.isTV) return PLATFORM_NAMES.appletv;
  return Platform.OS === 'ios' && Platform.isPad ? 'iPad' : 'iPhone';
}

/** Client identifier sent at sign-in, e.g. "Streamarr Android TV 0.1.0". */
export function clientName(): string {
  const version = Constants.expoConfig?.version ?? '0';
  return `Streamarr ${PLATFORM_NAMES[platformKey()]} ${version}`;
}
