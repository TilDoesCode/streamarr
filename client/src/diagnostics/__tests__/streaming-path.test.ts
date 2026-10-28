import {
  BANDWIDTH_MAX_AGE_MS,
  bandwidthStorageKey,
  deviceBandwidthKbps,
  isFreshBandwidth,
  readDeviceBandwidth,
  resetDeviceBandwidthCache,
  saveDeviceBandwidth,
} from '@/diagnostics/device-bandwidth';
import { pathVerdict } from '@/diagnostics/streaming-path';
import { deviceSettings } from '@/lib/storage';

const SERVER = 'http://tv.test:8080';
const result = (downloadMbps: number) => ({ downloadMbps, uploadMbps: 10, pingMs: 5, jitterMs: 1 });

beforeEach(() => {
  deviceSettings.remove(bandwidthStorageKey(SERVER));
  deviceSettings.remove(bandwidthStorageKey('http://phone.test'));
  resetDeviceBandwidthCache();
});

describe('streaming path verdict', () => {
  it('names the slower leg and what plays at its speed (30 % headroom like the server)', () => {
    expect(pathVerdict(300, 38)).toEqual({
      kind: 'both',
      bottleneck: 'device',
      limitMbps: 38,
      tier: 'uhd',
    });
    expect(pathVerdict(25, 400)).toEqual({
      kind: 'both',
      bottleneck: 'usenet',
      limitMbps: 25,
      tier: 'fhd',
    });
    expect(pathVerdict(120, 110)).toEqual({
      kind: 'both',
      bottleneck: 'even',
      limitMbps: 110,
      tier: 'uhdRemux',
    });
    expect(pathVerdict(5, 900)).toMatchObject({ tier: 'tooSlow' });
  });

  it('says which leg is missing', () => {
    expect(pathVerdict(undefined, 40)).toEqual({ kind: 'deviceOnly', limitMbps: 40, tier: 'uhd' });
    expect(pathVerdict(12, undefined)).toEqual({ kind: 'usenetOnly', limitMbps: 12, tier: 'hd' });
    expect(pathVerdict(undefined, 0)).toEqual({ kind: 'none' });
  });
});

describe('device bandwidth (kept per device and server)', () => {
  it('stores the speed test per server and sends it only while fresh', () => {
    const now = Date.UTC(2026, 9, 26, 12);
    saveDeviceBandwidth(SERVER, result(38.4), now);

    expect(readDeviceBandwidth(SERVER)).toMatchObject({ downloadMbps: 38.4, measuredAt: now });
    expect(readDeviceBandwidth('http://phone.test')).toBeUndefined();
    expect(deviceBandwidthKbps(SERVER, now + 1000)).toBe(38_400);
    expect(isFreshBandwidth(readDeviceBandwidth(SERVER), now + BANDWIDTH_MAX_AGE_MS)).toBe(true);
    expect(deviceBandwidthKbps(SERVER, now + BANDWIDTH_MAX_AGE_MS + 1)).toBeUndefined();
  });

  it('survives a restart (read back from storage) and ignores broken values', () => {
    saveDeviceBandwidth(SERVER, result(80), 1000);
    resetDeviceBandwidthCache();
    expect(readDeviceBandwidth(SERVER)?.downloadMbps).toBe(80);

    deviceSettings.set(bandwidthStorageKey(SERVER), '{"downloadMbps":"fast"}');
    resetDeviceBandwidthCache();
    expect(readDeviceBandwidth(SERVER)).toBeUndefined();
    saveDeviceBandwidth(SERVER, result(0), 1000);
    expect(readDeviceBandwidth(SERVER)).toBeUndefined();
  });
});
