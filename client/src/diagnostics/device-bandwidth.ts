import { useSyncExternalStore } from 'react';

import { serverKey } from '@/api/server-url';
import { deviceSettings } from '@/lib/storage';

import type { SpeedResult } from './speed-test';

/** After this a measurement is stale: the versions list stops sending it and asks for a new test. */
export const BANDWIDTH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** This device's last speed test against one server (TV and phone differ, so it lives on the device). */
export type DeviceBandwidth = {
  downloadMbps: number;
  uploadMbps?: number;
  pingMs?: number;
  jitterMs?: number;
  /** Epoch milliseconds. */
  measuredAt: number;
};

const listeners = new Set<() => void>();
const snapshots = new Map<string, DeviceBandwidth | null>();

export const bandwidthStorageKey = (serverUrl: string) => `bandwidth.${serverKey(serverUrl)}`;

function parse(raw: string | undefined): DeviceBandwidth | null {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== 'object') return null;
    const record = value as Partial<DeviceBandwidth>;
    return typeof record.downloadMbps === 'number' &&
      record.downloadMbps > 0 &&
      typeof record.measuredAt === 'number'
      ? (record as DeviceBandwidth)
      : null;
  } catch {
    return null;
  }
}

export function readDeviceBandwidth(serverUrl: string): DeviceBandwidth | undefined {
  const key = bandwidthStorageKey(serverUrl);
  if (!snapshots.has(key)) snapshots.set(key, parse(deviceSettings.getString(key)));
  return snapshots.get(key) ?? undefined;
}

export function saveDeviceBandwidth(serverUrl: string, result: SpeedResult, now = Date.now()) {
  if (!(result.downloadMbps > 0)) return;
  const record: DeviceBandwidth = {
    downloadMbps: result.downloadMbps,
    uploadMbps: result.uploadMbps,
    pingMs: result.pingMs,
    jitterMs: result.jitterMs,
    measuredAt: now,
  };
  const key = bandwidthStorageKey(serverUrl);
  deviceSettings.set(key, JSON.stringify(record));
  snapshots.set(key, record);
  for (const listener of listeners) listener();
}

export function isFreshBandwidth(record: DeviceBandwidth | undefined, now = Date.now()) {
  return !!record && now - record.measuredAt <= BANDWIDTH_MAX_AGE_MS;
}

/** What the app sends as `measuredBandwidthKbps`: the fresh download speed, else nothing. */
export function deviceBandwidthKbps(serverUrl: string, now = Date.now()): number | undefined {
  const record = readDeviceBandwidth(serverUrl);
  return isFreshBandwidth(record, now)
    ? Math.max(1, Math.round(record!.downloadMbps * 1000))
    : undefined;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDeviceBandwidth(serverUrl: string | undefined): DeviceBandwidth | undefined {
  return useSyncExternalStore(subscribe, () =>
    serverUrl ? readDeviceBandwidth(serverUrl) : undefined
  );
}

/** Test seam: forget the cached snapshots (the store itself is cleared by the caller). */
export function resetDeviceBandwidthCache() {
  snapshots.clear();
}
