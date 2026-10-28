import {
  bandwidthStorageKey,
  resetDeviceBandwidthCache,
  saveDeviceBandwidth,
} from '@/diagnostics/device-bandwidth';
import { deviceSettings } from '@/lib/storage';

import { json, world } from './mylist-world';

/** The account's server in the fake world. */
export const WORLD_SERVER = 'http://dev.test';

export const usenetResult = (overrides: Record<string, unknown> = {}) => ({
  status: 'ok',
  code: null,
  measuredAt: new Date(Date.now() - 3 * 60_000).toISOString(),
  megabitsPerSecond: 300,
  provider: { index: 1, role: 'primary', name: null, code: 'ok', error: null },
  fallbackUsed: false,
  attempts: [{ index: 1, role: 'primary', name: null, code: 'ok', error: null }],
  connectionsUsed: 8,
  connectionsMax: 20,
  activeStreams: 0,
  bytesDownloaded: 1,
  durationMs: 8000,
  firstByteMs: 100,
  reused: false,
  joined: false,
  freshUntil: new Date().toISOString(),
  ...overrides,
});

export function serveUsenet(latest: unknown, allowed = true) {
  world.handlers['GET /api/v1/viewer/diagnostics/usenet-speed'] = () =>
    json(200, { running: false, allowed, latest });
}

export function setDeviceMbps(mbps: number | null, ageMs = 2 * 24 * 3600_000) {
  deviceSettings.remove(bandwidthStorageKey(WORLD_SERVER));
  resetDeviceBandwidthCache();
  if (mbps !== null)
    saveDeviceBandwidth(
      WORLD_SERVER,
      { downloadMbps: mbps, uploadMbps: 20, pingMs: 4, jitterMs: 1 },
      Date.now() - ageMs
    );
}
