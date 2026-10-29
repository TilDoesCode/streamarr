import type { DeviceProfile } from '@modules/media-caps';

import { deviceSettings } from '@/lib/storage';
import {
  parseOverrides,
  pruneOverrides,
  saveCapabilityOverrides,
} from '@/player/capability-overrides';
import type { Playback } from '@/player/playback-api';
import {
  isDolbyVisionDirect,
  streamyboxEnabled,
  streamyboxOffered,
  withDolbyVision,
} from '@/player/streamybox';

let mockInstalled = true;
jest.mock('@modules/streamybox-player', () => ({ streamyboxInstalled: () => mockInstalled }));

/** The ROCK 4D: HEVC/AV1 10-bit HDR10 in hardware, an 8-bit-only H.264, VLC bundled. */
const box: DeviceProfile = {
  platform: 'androidtv',
  engines: [
    {
      engine: 'native',
      containers: ['mp4', 'mkv'],
      videoCodecs: [
        { codec: 'h264', maxWidth: 3840, maxHeight: 2160, maxBitDepth: 8, hdrFormats: [] },
        {
          codec: 'hevc',
          maxWidth: 3840,
          maxHeight: 2160,
          maxBitDepth: 10,
          hdrFormats: ['hdr10', 'hlg'],
        },
        { codec: 'av1', maxWidth: 3840, maxHeight: 2160, maxBitDepth: 10, hdrFormats: ['hdr10'] },
      ],
      audioCodecs: [{ codec: 'aac', maxChannels: 8 }],
      subtitleFormats: ['srt'],
      hls: true,
      maxAudioChannels: 8,
    },
    {
      engine: 'vlc',
      containers: ['mkv'],
      videoCodecs: [
        { codec: 'hevc', maxWidth: 3840, maxHeight: 2160, maxBitDepth: 10, hdrFormats: [] },
      ],
      audioCodecs: [{ codec: 'dts', maxChannels: 8 }],
      subtitleFormats: ['srt'],
      hls: true,
      maxAudioChannels: 8,
    },
  ],
  vlcAvailable: true,
};

const codec = (profile: DeviceProfile, engine: string, name: string) =>
  profile.engines
    .find((item) => item.engine === engine)!
    .videoCodecs.find((item) => item.codec === name)!;

const playback = (over: Partial<Playback> = {}, hdr = 'dolbyvision'): Playback =>
  ({
    playbackId: 'p1',
    state: 'ready',
    method: 'direct',
    engine: 'native',
    mediaInfo: { video: { codec: 'hevc', hdr, dolbyVisionProfile: 5 } },
    ...over,
  }) as Playback;

beforeEach(() => {
  mockInstalled = true;
  deviceSettings.clearAll();
});

describe('withDolbyVision', () => {
  it('adds dolbyvision to the built-in engine’s 10-bit HEVC only', () => {
    const dv = withDolbyVision(box);
    expect(codec(dv, 'native', 'hevc').hdrFormats).toEqual(['hdr10', 'hlg', 'dolbyvision']);
    expect(codec(dv, 'native', 'av1').hdrFormats).toEqual(['hdr10']);
    expect(codec(dv, 'native', 'h264').hdrFormats).toEqual([]);
    expect(codec(dv, 'vlc', 'hevc').hdrFormats).toEqual([]);
  });

  it('is a clone: the normal profile never gets dolbyvision', () => {
    const before = JSON.stringify(box);
    const dv = withDolbyVision(box);
    expect(JSON.stringify(box)).toBe(before);
    expect(dv).not.toBe(box);
    expect(codec(box, 'native', 'hevc').hdrFormats).toEqual(['hdr10', 'hlg']);
  });

  it('leaves an 8-bit HEVC decoder alone and never adds the format twice', () => {
    const eightBit: DeviceProfile = {
      ...box,
      engines: [
        {
          ...box.engines[0]!,
          videoCodecs: [{ codec: 'hevc', maxHeight: 1080, maxBitDepth: 8, hdrFormats: [] }],
        },
      ],
    };
    expect(codec(withDolbyVision(eightBit), 'native', 'hevc').hdrFormats).toEqual([]);
    const twice = withDolbyVision(withDolbyVision(box));
    expect(codec(twice, 'native', 'hevc').hdrFormats).toEqual(['hdr10', 'hlg', 'dolbyvision']);
  });
});

describe('isDolbyVisionDirect', () => {
  it('takes a ready original Dolby Vision file for the built-in engine', () => {
    expect(isDolbyVisionDirect(playback())).toBe(true);
    expect(isDolbyVisionDirect(playback({ engine: undefined }))).toBe(true);
  });

  it('never takes a remux, a transcode, VLC, an unready start or other HDR', () => {
    expect(isDolbyVisionDirect(playback({ method: 'remux' }))).toBe(false);
    expect(isDolbyVisionDirect(playback({ method: 'transcode' }))).toBe(false);
    expect(isDolbyVisionDirect(playback({ engine: 'vlc' }))).toBe(false);
    expect(isDolbyVisionDirect(playback({ state: 'preparing' } as never))).toBe(false);
    expect(isDolbyVisionDirect(playback({}, 'hdr10'))).toBe(false);
    expect(isDolbyVisionDirect(null)).toBe(false);
  });
});

describe('Streamybox setting', () => {
  it('is offered only with the feature and the installed render service', () => {
    expect(streamyboxOffered({ streamyboxDolbyVision: true })).toBe(true);
    expect(streamyboxOffered({ streamyboxDolbyVision: false })).toBe(false);
    expect(streamyboxOffered({})).toBe(false);
    mockInstalled = false;
    expect(streamyboxOffered({ streamyboxDolbyVision: true })).toBe(false);
  });

  it('is automatic by default where offered and stays off once turned off', () => {
    expect(streamyboxEnabled({ streamyboxDolbyVision: true })).toBe(true);
    saveCapabilityOverrides({ dolbyVisionPlayer: 'off' });
    expect(streamyboxEnabled({ streamyboxDolbyVision: true })).toBe(false);
    saveCapabilityOverrides({});
    expect(streamyboxEnabled({ streamyboxDolbyVision: false })).toBe(false);
  });

  it('stores only "off": automatic is no override, junk is dropped', () => {
    expect(parseOverrides('{"dolbyVisionPlayer":"off"}')).toEqual({ dolbyVisionPlayer: 'off' });
    expect(parseOverrides('{"dolbyVisionPlayer":"auto"}')).toEqual({});
    expect(parseOverrides('{"dolbyVisionPlayer":true}')).toEqual({});
    expect(pruneOverrides({ dolbyVisionPlayer: 'off' }, box)).toEqual({ dolbyVisionPlayer: 'off' });
    expect(pruneOverrides({ dolbyVisionPlayer: undefined }, box)).toEqual({});
  });
});
