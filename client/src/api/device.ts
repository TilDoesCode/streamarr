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

// Manufacturers whose spelling is not just a capital first letter.
const BRANDS: Record<string, string> = {
  htc: 'HTC',
  lge: 'LG',
  lg: 'LG',
  nvidia: 'NVIDIA',
  oneplus: 'OnePlus',
  tcl: 'TCL',
  zte: 'ZTE',
  hmd: 'HMD',
};

function brandName(brand: string): string {
  const known = BRANDS[brand.toLowerCase()];
  if (known) return known;
  return brand === brand.toLowerCase() ? brand.charAt(0).toUpperCase() + brand.slice(1) : brand;
}

/** Android brand + model as people say it: "Google Pixel 8", "Samsung SM-S921B", emulators as "Emulator". */
export function friendlyModel(brand: string | undefined, model: string | undefined): string {
  const name = (model ?? '').trim();
  const maker = (brand ?? '').trim();
  if (/^sdk_|_sdk_|^sdk$|emulator|^generic/i.test(name)) return 'Emulator';
  if (!maker) return name;
  if (!name) return brandName(maker);
  if (name.toLowerCase().startsWith(maker.toLowerCase())) return name;
  return `${brandName(maker)} ${name}`;
}

/** A stored device name for display: older Android clients sent the raw lowercase brand and model; null if unknown. */
export function displayDeviceName(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  if (!trimmed || trimmed === 'Unknown device') return null;
  const raw = /^([a-z]+) (.+) \(([^()]+)\)$/.exec(trimmed);
  return raw ? `${friendlyModel(raw[1], raw[2])} (${raw[3]})` : trimmed;
}

/** Name the server shows in the viewer's device list (not UI copy: model or browser, not translated). */
export function deviceName(): string {
  if (Platform.OS === 'web') {
    const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
    return `${browserName(agent)} (${PLATFORM_NAMES.web})`;
  }
  if (Platform.OS === 'android') {
    const { Brand, Model } = Platform.constants as { Brand?: string; Model?: string };
    const model = friendlyModel(Brand, Model);
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
