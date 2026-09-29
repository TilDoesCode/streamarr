import type { MediaCapsReport, VideoDecoderInfo } from '@modules/media-caps/src/MediaCaps.types';
import { buildDeviceProfile, chooseDecoders } from '@modules/media-caps/src/profile';

function video(
  name: string,
  codec: string,
  hardware: boolean,
  extra: Partial<VideoDecoderInfo> = {}
): VideoDecoderInfo {
  return {
    name,
    codec,
    hardware,
    softwareOnly: !hardware,
    maxWidth: 3840,
    maxHeight: 2160,
    maxBitDepth: 8,
    hdrFormats: [],
    ...extra,
  };
}

const audio = (codec: string, maxChannels = 8) => ({
  name: `c2.android.${codec}.decoder`,
  codec,
  hardware: false,
  softwareOnly: true,
  maxChannels,
});

/** Trimmed from the Google TV emulator (API 36) report measured in M3.1. */
const googleTvEmulator: MediaCapsReport = {
  platform: 'androidtv',
  device: { isTV: true, isEmulator: true, model: 'sdk_google_atv64_amati_arm64' },
  videoDecoders: [
    video('c2.goldfish.h264.decoder', 'h264', true),
    video('c2.goldfish.hevc.decoder', 'hevc', true),
    video('c2.goldfish.vp9.decoder', 'vp9', true, { maxBitDepth: 10, hdrFormats: ['hlg'] }),
    video('c2.android.av1-dav1d.decoder', 'av1', false, {
      maxWidth: 1920,
      maxHeight: 1080,
      maxBitDepth: 10,
      hdrFormats: ['hlg'],
    }),
    video('c2.android.hevc.decoder', 'hevc', false),
    video('c2.android.mpeg2.decoder', 'mpeg2video', false, { maxWidth: 1920, maxHeight: 1080 }),
  ],
  audioDecoders: [audio('aac'), audio('mp3', 2), audio('opus'), audio('flac'), audio('pcm', 12)],
  display: { width: 1920, height: 1080, refreshRate: 60, hdrTypes: [] },
  audioOutput: {
    devices: [],
    passthrough: [],
    maxChannels: 2,
    api: 'getDirectProfilesForAttributes',
  },
};

/** A 4K HDR TV box on a Dolby Vision TV with an eARC receiver. */
const hdrTvBox: MediaCapsReport = {
  ...googleTvEmulator,
  device: { isTV: true, isEmulator: false },
  videoDecoders: [
    video('c2.vendor.avc.decoder', 'h264', true),
    video('c2.vendor.hevc.decoder', 'hevc', true, {
      maxBitDepth: 10,
      hdrFormats: ['hdr10', 'hdr10plus', 'hlg'],
    }),
    video('c2.vendor.dolby-vision.decoder', 'dolbyvision', true, {
      maxBitDepth: 10,
      hdrFormats: ['dolbyvision'],
    }),
    video('c2.android.av1-dav1d.decoder', 'av1', false, { maxBitDepth: 10 }),
  ],
  display: { width: 3840, height: 2160, hdrTypes: ['dolbyvision', 'hdr10', 'hlg'] },
  audioOutput: {
    devices: [],
    passthrough: ['ac3', 'eac3', 'eac3-joc', 'truehd', 'dts-hd'],
    maxChannels: 8,
    api: 'getDirectProfilesForAttributes',
  },
};

const chrome: MediaCapsReport = {
  platform: 'web',
  device: { isTV: false, isEmulator: false, model: 'Chrome' },
  videoDecoders: [
    video('Chrome h264', 'h264', true),
    video('Chrome hevc', 'hevc', true, { maxBitDepth: 10, hdrFormats: ['hdr10'] }),
    video('Chrome vp9', 'vp9', false, { maxBitDepth: 10 }),
  ],
  audioDecoders: [audio('aac', 2), audio('opus', 2)],
  display: { hdrTypes: [] },
  audioOutput: { devices: [], passthrough: [], maxChannels: 2, api: 'AudioContext' },
  web: {
    browser: 'Chrome',
    userAgent: '',
    mse: true,
    managedMse: false,
    nativeHls: false,
    mediaCapabilities: true,
  },
};

describe('media-caps device profile', () => {
  it('distinguishes hardware and software decoders and caps software-only codecs', () => {
    const choices = chooseDecoders(googleTvEmulator);
    const hevc = choices.find((choice) => choice.codec === 'hevc');
    expect(hevc).toMatchObject({
      uses: 'hardware',
      hardware: ['c2.goldfish.hevc.decoder'],
      software: ['c2.android.hevc.decoder'],
      maxHeight: 2160,
      maxBitDepth: 8,
    });
    expect(choices.find((choice) => choice.codec === 'av1')).toMatchObject({
      uses: 'software',
      maxHeight: 1080,
    });
    expect(choices.find((choice) => choice.codec === 'vc1')).toMatchObject({ uses: 'none' });
  });

  it('builds the Google TV emulator profile the playback API expects', () => {
    const profile = buildDeviceProfile(googleTvEmulator, { vlc: true });
    expect(profile.platform).toBe('androidtv');
    expect(profile.vlcAvailable).toBe(true);
    const [native, vlc] = profile.engines;
    expect(native).toMatchObject({ engine: 'native', hls: true, maxAudioChannels: 2 });
    expect(native!.containers).toContain('mkv');
    expect(native!.videoCodecs.map((codec) => codec.codec)).toEqual([
      'h264',
      'hevc',
      'av1',
      'vp9',
      'mpeg2video',
    ]);
    expect(native!.videoCodecs.every((codec) => codec.hdrFormats!.length === 0)).toBe(true);
    expect(native!.audioCodecs.map((codec) => codec.codec)).toEqual(
      expect.not.arrayContaining(['ac3', 'eac3', 'dts', 'truehd'])
    );
    // VLC decodes 10-bit HEVC in software only (the goldfish decoder is 8-bit), so it is capped at 1080p.
    expect(vlc!.videoCodecs.find((codec) => codec.codec === 'hevc')).toMatchObject({
      maxHeight: 1080,
      maxBitDepth: 10,
    });
    expect(vlc!.videoCodecs.find((codec) => codec.codec === 'h264')).toMatchObject({
      maxHeight: 2160,
    });
  });

  it('signals HDR only where decoder and display agree, and passthrough for bitstreamed audio', () => {
    const profile = buildDeviceProfile(hdrTvBox, { vlc: true });
    const native = profile.engines[0]!;
    expect(native.videoCodecs.find((codec) => codec.codec === 'hevc')).toMatchObject({
      maxBitDepth: 10,
      hdrFormats: ['hdr10', 'hlg', 'dolbyvision'],
    });
    expect(native.audioCodecs).toEqual(
      expect.arrayContaining([
        { codec: 'eac3', passthrough: true },
        { codec: 'truehd', passthrough: true },
        { codec: 'dts', passthrough: true },
      ])
    );
    expect(native.maxAudioChannels).toBe(8);
  });

  it('builds a browser profile without VLC', () => {
    const profile = buildDeviceProfile(chrome, { vlc: true });
    expect(profile).toMatchObject({ platform: 'web', vlcAvailable: false });
    expect(profile.engines).toHaveLength(1);
    expect(profile.engines[0]).toMatchObject({
      engine: 'web',
      containers: ['mp4', 'webm'],
      subtitleFormats: ['webvtt'],
      hls: true,
    });
    // No HDR display: the decoder's HDR10 support is not signalled.
    expect(
      profile.engines[0]!.videoCodecs.find((codec) => codec.codec === 'hevc')!.hdrFormats
    ).toEqual([]);
  });
});
