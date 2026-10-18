import type { DeviceProfile } from '@modules/media-caps';

import { deviceSettings } from '@/lib/storage';
import {
  applyCapabilityOverrides,
  heightChoices,
  heightTier,
  overrideCount,
  parseOverrides,
  preferredEngine,
  pruneOverrides,
  saveCapabilityOverrides,
  storedCapabilityOverrides,
} from '@/player/capability-overrides';
import { loadDeviceCaps, versionHints } from '@/player/device-profile';

/** A 4K Android TV box: HEVC/AV1 HDR10 in hardware, AC3 and EAC3 decoded, VLC bundled. */
const box: DeviceProfile = {
  platform: 'androidtv',
  engines: [
    {
      engine: 'native',
      containers: ['mp4', 'mkv'],
      videoCodecs: [
        { codec: 'h264', maxWidth: 3840, maxHeight: 2160, maxBitDepth: 8, hdrFormats: [] },
        { codec: 'hevc', maxWidth: 3840, maxHeight: 2160, maxBitDepth: 10, hdrFormats: ['hdr10'] },
        { codec: 'vp9', maxWidth: 1920, maxHeight: 1080, maxBitDepth: 8, hdrFormats: [] },
      ],
      audioCodecs: [
        { codec: 'aac', maxChannels: 8 },
        { codec: 'ac3', maxChannels: 6 },
        { codec: 'eac3', maxChannels: 8 },
      ],
      subtitleFormats: ['srt'],
      hls: true,
      maxAudioChannels: 2,
    },
    {
      engine: 'vlc',
      containers: ['mkv'],
      videoCodecs: [
        { codec: 'h264', maxWidth: 3840, maxHeight: 2160, maxBitDepth: 8, hdrFormats: [] },
        { codec: 'hevc', maxWidth: 3840, maxHeight: 2160, maxBitDepth: 10, hdrFormats: [] },
      ],
      audioCodecs: [
        { codec: 'ac3', maxChannels: 8 },
        { codec: 'dts', maxChannels: 8 },
      ],
      subtitleFormats: ['srt'],
      hls: true,
      maxAudioChannels: 2,
    },
  ],
  vlcAvailable: true,
};

const native = (profile: DeviceProfile) => profile.engines[0]!;
const vlc = (profile: DeviceProfile) => profile.engines.find((engine) => engine.engine === 'vlc');

describe('applyCapabilityOverrides', () => {
  it('returns the detected profile unchanged without overrides', () => {
    expect(applyCapabilityOverrides(box, {})).toEqual(box);
  });

  it('turns a video codec off in every engine and forces an undetected one on', () => {
    const profile = applyCapabilityOverrides(box, { video: { hevc: false, av1: true } });
    expect(native(profile).videoCodecs.map((codec) => codec.codec)).toEqual(['h264', 'vp9', 'av1']);
    expect(vlc(profile)?.videoCodecs.map((codec) => codec.codec)).toEqual(['h264', 'av1']);
    expect(native(profile).videoCodecs[2]).toEqual({
      codec: 'av1',
      maxWidth: 3840,
      maxHeight: 2160,
      maxBitDepth: 10,
      hdrFormats: [],
    });
  });

  it('caps or raises the resolution of every codec', () => {
    const lower = applyCapabilityOverrides(box, { maxHeight: 1080 });
    expect(lower.engines.flatMap((e) => e.videoCodecs.map((c) => c.maxHeight))).toEqual([
      1080, 1080, 1080, 1080, 1080,
    ]);
    expect(native(lower).videoCodecs[0]?.maxWidth).toBe(1920);
    const higher = applyCapabilityOverrides(box, { maxHeight: 2160 });
    expect(native(higher).videoCodecs[2]).toMatchObject({ maxHeight: 2160, maxWidth: 3840 });
  });

  it('adds HDR formats only to codecs that can carry them and removes them everywhere', () => {
    const profile = applyCapabilityOverrides(box, {
      hdr: { dolbyvision: true, hlg: true, hdr10: false },
    });
    const [h264, hevc, vp9] = native(profile).videoCodecs;
    expect(h264?.hdrFormats).toEqual([]);
    expect(hevc?.hdrFormats).toEqual(['dolbyvision', 'hlg']);
    // VP9 has no Dolby Vision; HLG needs 10 bit, which the override implies.
    expect(vp9).toMatchObject({ hdrFormats: ['hlg'], maxBitDepth: 10 });
    expect(vlc(profile)?.videoCodecs[1]?.hdrFormats).toEqual([]);
  });

  it('switches audio between off, decoding and passthrough', () => {
    const profile = applyCapabilityOverrides(box, {
      audio: { ac3: 'passthrough', aac: 'off', truehd: 'decode' },
    });
    expect(native(profile).audioCodecs).toEqual([
      { codec: 'eac3', maxChannels: 8 },
      { codec: 'ac3', passthrough: true },
      { codec: 'truehd', maxChannels: 2 },
    ]);
    // VLC keeps decoding AC3 itself; only "off" reaches it.
    expect(vlc(profile)?.audioCodecs.map((codec) => codec.codec)).toEqual(['ac3', 'dts']);
    const off = applyCapabilityOverrides(box, { audio: { ac3: 'off' } });
    expect(vlc(off)?.audioCodecs.map((codec) => codec.codec)).toEqual(['dts']);
  });

  it('sets the channel limit and caps the per-codec channels', () => {
    const profile = applyCapabilityOverrides(box, { maxAudioChannels: 6 });
    expect(profile.engines.map((engine) => engine.maxAudioChannels)).toEqual([6, 6]);
    expect(native(profile).audioCodecs.map((codec) => codec.maxChannels)).toEqual([6, 6, 6]);
  });

  it('drops VLC and sets the bitrate limit', () => {
    const profile = applyCapabilityOverrides(box, { vlc: false, maxBitrateKbps: 20_000 });
    expect(profile.engines.map((engine) => engine.engine)).toEqual(['native']);
    expect(profile.vlcAvailable).toBe(false);
    expect(profile.maxBitrateKbps).toBe(20_000);
  });

  it('changes the versions hints the server predicts with', () => {
    const hints = versionHints(
      applyCapabilityOverrides(box, {
        video: { hevc: false },
        audio: { ac3: 'passthrough' },
        maxHeight: 1080,
        vlc: false,
      })
    );
    expect(hints).toMatchObject({
      videoCodecs: 'h264,vp9',
      audioCodecs: 'aac,eac3,ac3',
      hdrFormats: undefined,
      maxHeight: 1080,
    });
    expect(hints?.vlcAvailable).toBeUndefined();
  });
});

describe('resolution steps', () => {
  it('snaps decoder heights to the step they reach', () => {
    expect(heightTier(4320)).toBe(4320);
    expect(heightTier(2304)).toBe(2160);
    expect(heightTier(1088)).toBe(1080);
    expect(heightTier(576)).toBe(720);
  });

  it('offers up to 4K, and 8K only where the decoders reach it', () => {
    expect(heightChoices(1080)).toEqual([720, 1080, 1440, 2160]);
    expect(heightChoices(undefined)).toEqual([720, 1080, 1440, 2160]);
    expect(heightChoices(4320)).toEqual([720, 1080, 1440, 2160, 4320]);
  });
});

describe('pruneOverrides', () => {
  it('keeps only values that differ from the detected profile', () => {
    const pruned = pruneOverrides(
      {
        video: { h264: true, av1: true },
        hdr: { hdr10: true, hlg: false, dolbyvision: true },
        audio: { aac: 'decode', ac3: 'passthrough' },
        maxAudioChannels: 2,
        maxHeight: 2160,
        maxBitrateKbps: 8000,
        vlc: true,
        engine: 'auto',
      },
      box
    );
    expect(pruned).toEqual({
      video: { av1: true },
      hdr: { dolbyvision: true },
      audio: { ac3: 'passthrough' },
      maxBitrateKbps: 8000,
    });
    expect(overrideCount(pruned)).toBe(4);
    expect(overrideCount({})).toBe(0);
  });

  it('treats the step a detected odd height shows as as no override', () => {
    const odd: DeviceProfile = {
      ...box,
      engines: [
        {
          ...box.engines[0]!,
          videoCodecs: [{ codec: 'hevc', maxWidth: 4096, maxHeight: 2304, maxBitDepth: 10 }],
        },
      ],
    };
    expect(pruneOverrides({ maxHeight: 2160 }, odd)).toEqual({});
    expect(pruneOverrides({ maxHeight: 2304 }, odd)).toEqual({});
    expect(pruneOverrides({ maxHeight: 1440 }, odd)).toEqual({ maxHeight: 1440 });
  });
});

describe('stored overrides', () => {
  afterEach(() => deviceSettings.remove('capabilities.overrides'));

  it('ignores malformed values', () => {
    expect(parseOverrides('{nope')).toEqual({});
    expect(parseOverrides('[1]')).toEqual({});
    expect(
      parseOverrides(
        JSON.stringify({
          video: { hevc: false, av1: 'yes' },
          audio: { ac3: 'passthrough', dts: 'loud' },
          maxAudioChannels: 99,
          maxHeight: 1080,
          engine: 'mpv',
        })
      )
    ).toEqual({ video: { hevc: false }, audio: { ac3: 'passthrough' }, maxHeight: 1080 });
  });

  it('round-trips through the device settings and clears the key when empty', () => {
    saveCapabilityOverrides({ maxHeight: 1080, engine: 'vlc' });
    expect(storedCapabilityOverrides()).toEqual({ maxHeight: 1080, engine: 'vlc' });
    expect(preferredEngine()).toEqual({ engine: 'vlc' });
    saveCapabilityOverrides({ engine: 'vlc', vlc: false });
    expect(preferredEngine()).toBeUndefined();
    saveCapabilityOverrides({});
    expect(deviceSettings.getString('capabilities.overrides')).toBeUndefined();
  });

  it('applies the stored overrides where the profile is produced', async () => {
    const caps = jest.requireMock<{ getCapabilitiesAsync: jest.Mock }>(
      '@modules/media-caps/src/MediaCapsModule'
    );
    saveCapabilityOverrides({ maxBitrateKbps: 12_000 });
    const spy = jest.spyOn(caps, 'getCapabilitiesAsync');
    spy.mockResolvedValue({
      platform: 'web',
      device: { isTV: false, isEmulator: false },
      videoDecoders: [],
      audioDecoders: [],
      display: { hdrTypes: [] },
      audioOutput: { devices: [], passthrough: [], maxChannels: 2, api: 'test' },
    });
    expect((await loadDeviceCaps()).profile.maxBitrateKbps).toBe(12_000);
    spy.mockRestore();
  });
});
