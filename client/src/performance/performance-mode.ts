import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import { hostDevice, type HostDevice } from '@modules/host-system';

import { deviceSettings } from '@/lib/storage';

/** Settings choice: `auto` decides from the hardware, `on`/`off` force the lite UI. */
export type PerformancePreference = 'auto' | 'off' | 'on';

export const PERFORMANCE_PREFERENCES: readonly PerformancePreference[] = ['auto', 'off', 'on'];

/** Why `auto` turned the lite UI on (shown in Settings). */
export type WeakReason = 'animationsOff' | 'lowRam' | 'memory' | 'soc' | 'cpu';

export type DeviceEnv = { os: string; isTV: boolean };

const STORAGE_KEY = 'performanceMode';

// SoCs of TV boxes whose GPU/CPU cannot keep the full UI at 60 fps (lowercase prefixes of SOC_MODEL / board platform / hardware).
const WEAK_SOCS = [
  'rk3576',
  'rk3568',
  'rk3566',
  'rk3562',
  'rk3399',
  'rk3328',
  'rk3318',
  'rk322',
  's905',
  's805',
  'h616',
  'h618',
  'h313',
  'h6',
  'mt8695',
  'mt9',
];

// Below this RAM a TV box also gets the lite UI (2 GB boxes report ~1.8–2.0 GB).
const MIN_MEMORY_MB = 2600;
// A fastest core below this clock means only little cores (A53/A55-class).
const MIN_CPU_MHZ = 1900;

function matchesWeakSoc(value: string | null | undefined): boolean {
  const name = value?.trim().toLowerCase();
  return !!name && WEAK_SOCS.some((soc) => name.startsWith(soc));
}

/** Why the device counts as weak hardware, or null. Only Android TV is classified by hardware; removed system animations count everywhere. */
export function weakDeviceReason(device: HostDevice, env: DeviceEnv): WeakReason | null {
  if (device.animatorScale === 0) return 'animationsOff';
  if (env.os !== 'android' || !env.isTV) return null;
  if (device.lowRam) return 'lowRam';
  if ([device.socModel, device.boardPlatform, device.hardware].some(matchesWeakSoc)) return 'soc';
  if (device.totalMemoryMb && device.totalMemoryMb < MIN_MEMORY_MB) return 'memory';
  if (device.maxCpuMhz && device.maxCpuMhz < MIN_CPU_MHZ) return 'cpu';
  return null;
}

/** Whether the lite UI is on for this preference and device. */
export function resolveLiteMode(
  preference: PerformancePreference,
  device: HostDevice,
  env: DeviceEnv
): boolean {
  if (preference !== 'auto') return preference === 'on';
  return weakDeviceReason(device, env) !== null;
}

function isPreference(value: unknown): value is PerformancePreference {
  return PERFORMANCE_PREFERENCES.includes(value as PerformancePreference);
}

// Every card and Focusable reads the mode: one MMKV listener and a cached value serve them all.
let cached: PerformancePreference | null = null;
const subscribers = new Set<() => void>();
let storeListener: { remove: () => void } | null = null;

/** Per device (MMKV), not per account. */
export function readPerformancePreference(): PerformancePreference {
  if (cached) return cached;
  const stored = deviceSettings.getString(STORAGE_KEY);
  return (cached = isPreference(stored) ? stored : 'auto');
}

export function writePerformancePreference(preference: PerformancePreference): void {
  if (preference === 'auto') deviceSettings.remove(STORAGE_KEY);
  else deviceSettings.set(STORAGE_KEY, preference);
  changed();
}

function changed() {
  const before = cached;
  cached = null;
  if (readPerformancePreference() !== before) for (const notify of [...subscribers]) notify();
}

export function subscribePerformancePreference(onChange: () => void): () => void {
  storeListener ??= deviceSettings.addOnValueChangedListener((key) => {
    if (key === STORAGE_KEY) changed();
  });
  subscribers.add(onChange);
  return () => subscribers.delete(onChange);
}

const ENV: DeviceEnv = { os: Platform.OS, isTV: Platform.isTV === true };

/** This device's weak-hardware reason (fixed for the app's run). */
export const deviceWeakReason: WeakReason | null = weakDeviceReason(hostDevice, ENV);

/** Lite UI on now (non-reactive; components use `useLiteMode`). */
export function isLiteMode(): boolean {
  return resolveLiteMode(readPerformancePreference(), hostDevice, ENV);
}

export function usePerformancePreference(): PerformancePreference {
  return useSyncExternalStore(
    subscribePerformancePreference,
    readPerformancePreference,
    readPerformancePreference
  );
}

/** Reduced animations and the lean layouts; follows the setting live. */
export function useLiteMode(): boolean {
  return useSyncExternalStore(subscribePerformancePreference, isLiteMode, isLiteMode);
}
