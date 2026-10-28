import type { MediaCapsReport, VideoDecoderInfo } from '@modules/media-caps/src/MediaCaps.types';
import {
  buildDeviceProfile,
  chooseDecoders,
  passthroughDiagnosis,
} from '@modules/media-caps/src/profile';

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

/** Measured on the Radxa Rock 4D (RK3576, API 34) at an LG C1: Rockchip decoders list Main10 but no HDR10 profile, HDMI takes Dolby/DTS bitstreams. */
const rock4d: MediaCapsReport = {
  platform: 'androidtv',
  device: { isTV: true, isEmulator: false, model: 'rk3576_rock_4d', sdkInt: 34 },
  videoDecoders: [
    video('c2.rk.avc.decoder', 'h264', true, { maxWidth: 7680, maxHeight: 4320 }),
    video('c2.rk.hevc.decoder', 'hevc', true, {
      maxWidth: 7680,
      maxHeight: 4320,
      maxBitDepth: 10,
      hdrFormats: ['hlg'],
    }),
    video('c2.rk.av1.decoder', 'av1', true, {
      maxWidth: 7680,
      maxHeight: 4320,
      maxBitDepth: 10,
      hdrFormats: ['hlg'],
    }),
    video('c2.rk.vp9.decoder', 'vp9', true, {
      maxWidth: 7680,
      maxHeight: 4320,
      maxBitDepth: 10,
      hdrFormats: ['hdr10', 'hlg'],
    }),
  ],
  audioDecoders: [audio('aac'), audio('mp3', 2), audio('opus'), audio('flac')],
  display: { width: 3840, height: 2160, hdrTypes: ['hdr10', 'hlg'] },
  audioOutput: {
    devices: [{ type: 'hdmi', name: 'rk3576_rock_4d', channelCounts: [], encodings: [] }],
    passthrough: ['ac3', 'eac3', 'eac3-joc', 'dts', 'dts-hd'],
    maxChannels: 2,
    api: 'getDirectProfilesForAttributes',
  },
};

describe('media-caps device profile', () => {
  it('shows HDR10 for Android 10-bit decoders that only list Main10, never Dolby Vision without its decoder', () => {
    const native = buildDeviceProfile(rock4d, { vlc: true }).engines[0]!;
    for (const codec of ['hevc', 'av1', 'vp9']) {
      expect(native.videoCodecs.find((item) => item.codec === codec)!.hdrFormats).toEqual([
        'hdr10',
        'hlg',
      ]);
    }
    expect(native.videoCodecs.find((item) => item.codec === 'h264')!.hdrFormats).toEqual([]);
    expect(native.audioCodecs).toEqual(
      expect.arrayContaining([
        { codec: 'ac3', passthrough: true },
        { codec: 'eac3', passthrough: true },
        { codec: 'dts', passthrough: true },
      ])
    );
    expect(native.maxAudioChannels).toBe(2);
  });

  it('keeps the decoder HDR list of browsers and Apple players', () => {
    const hevc = chooseDecoders({ ...chrome, display: { hdrTypes: ['hdr10', 'hlg'] } }).find(
      (choice) => choice.codec === 'vp9'
    );
    expect(hevc!.hdrFormats).toEqual([]);
  });

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

/**
 * The Streamybox system feature `dev.streamybox.dolby_vision=1`: HEVC Main10 decoders, an HDR10-only sink,
 * no `video/dolby-vision` MediaCodec. `dev.streamybox.player` decodes DV and tone-maps it to HDR10.
 */
const streamyboxDv: MediaCapsReport = {
  ...rock4d,
  streamyboxDolbyVision: true,
  display: { width: 3840, height: 2160, hdrTypes: ['hdr10'] },
};

describe('media-caps Streamybox Dolby Vision player', () => {
  it('reports DV for HEVC from the system player feature, without a DV decoder or DV display', () => {
    expect(streamyboxDv.videoDecoders.some((decoder) => decoder.codec === 'dolbyvision')).toBe(
      false
    );
    const choices = chooseDecoders(streamyboxDv);
    expect(choices.find((choice) => choice.codec === 'hevc')!.hdrFormats).toEqual([
      'hdr10',
      'dolbyvision',
    ]);
    // The player's DV transport is HEVC only.
    expect(choices.find((choice) => choice.codec === 'av1')!.hdrFormats).toEqual(['hdr10']);
  });

  it('is unchanged without the feature', () => {
    const choices = chooseDecoders({ ...streamyboxDv, streamyboxDolbyVision: false });
    expect(choices.find((choice) => choice.codec === 'hevc')!.hdrFormats).toEqual(['hdr10']);
    expect(choices.find((choice) => choice.codec === 'av1')!.hdrFormats).toEqual(['hdr10']);
  });

  it('puts dolbyvision into the HEVC codec of the DeviceProfile', () => {
    const native = buildDeviceProfile(streamyboxDv, { vlc: true }).engines[0]!;
    expect(native.videoCodecs.find((codec) => codec.codec === 'hevc')!.hdrFormats).toEqual([
      'hdr10',
      'dolbyvision',
    ]);
    expect(native.videoCodecs.find((codec) => codec.codec === 'av1')!.hdrFormats).toEqual([
      'hdr10',
    ]);
  });

  it('does not claim DV from an 8-bit HEVC decoder', () => {
    const report: MediaCapsReport = {
      ...streamyboxDv,
      videoDecoders: streamyboxDv.videoDecoders.map((decoder) =>
        decoder.codec === 'hevc' ? { ...decoder, maxBitDepth: 8, hdrFormats: [] } : decoder
      ),
    };
    expect(chooseDecoders(report).find((choice) => choice.codec === 'hevc')!.hdrFormats).toEqual(
      []
    );
  });
});

describe('passthroughDiagnosis (ROCK 4D, task audio)', () => {
  const box = (audioOutput: Partial<MediaCapsReport['audioOutput']>): MediaCapsReport => ({
    ...googleTvEmulator,
    device: { isTV: true, isEmulator: false, manufacturer: 'Radxa', model: 'ROCK 4D' },
    audioOutput: {
      devices: [],
      passthrough: [],
      maxChannels: 8,
      api: 'media3',
      surroundMode: 'auto',
      tvMode: true,
      ...audioOutput,
    },
  });

  it('is silent when the player passes through everything the output lists', () => {
    const report = box({
      passthrough: ['ac3', 'eac3', 'eac3-joc', 'truehd'],
      hdmiEncodings: ['ac3', 'eac3', 'eac3-joc', 'truehd'],
    });
    expect(passthroughDiagnosis(report)).toEqual({ refused: [], reason: null });
    expect(buildDeviceProfile(report, { vlc: true }).engines[0]!.audioCodecs).toEqual(
      expect.arrayContaining([
        { codec: 'truehd', passthrough: true },
        { codec: 'eac3', passthrough: true },
      ])
    );
  });

  it('blames the Stereo/PCM surround setting first', () => {
    const report = box({ surroundMode: 'never', hdmiEncodings: ['ac3', 'truehd'] });
    expect(passthroughDiagnosis(report)).toEqual({
      refused: ['ac3', 'truehd'],
      reason: 'surroundNever',
    });
  });

  it('names a box outside the TV ui mode (Media3 then ignores the direct profiles)', () => {
    const report = box({ tvMode: false, hdmiEncodings: ['ac3', 'eac3'] });
    expect(passthroughDiagnosis(report).reason).toBe('notTvMode');
  });

  it('spots formats the HAL only offers wrapped as IEC 61937 and never declares them', () => {
    const report = box({
      directProfiles: [
        { format: 'ac3', iec61937: true, channels: 2 },
        { format: 'eac3', iec61937: true, channels: 2 },
        { format: 'truehd', iec61937: true, channels: 8 },
      ],
    });
    expect(passthroughDiagnosis(report)).toEqual({
      refused: ['ac3', 'eac3', 'truehd'],
      reason: 'iec61937Only',
    });
    const audio = buildDeviceProfile(report, { vlc: true }).engines[0]!.audioCodecs;
    expect(audio.some((codec) => codec.passthrough)).toBe(false);
  });

  it('explains TrueHD that only passes through as 5.1', () => {
    const report = box({
      passthrough: ['ac3', 'eac3'],
      passthroughChannels: { ac3: 6, eac3: 6, truehd: 6 },
      hdmiEncodings: ['ac3', 'eac3', 'truehd'],
    });
    expect(passthroughDiagnosis(report)).toEqual({ refused: ['truehd'], reason: 'channels' });
  });

  it('says so when the HDMI output lists no bitstream format at all', () => {
    const hdmi = { type: 'hdmi', name: 'LG TV', channelCounts: [2], encodings: [] };
    expect(passthroughDiagnosis(box({ devices: [hdmi], hdmiEncodings: [] })).reason).toBe(
      'noneReported'
    );
    // No HDMI output at all (emulator, speaker): nothing to explain.
    expect(passthroughDiagnosis(box({ hdmiEncodings: [] })).reason).toBeNull();
    expect(passthroughDiagnosis({ ...chrome }).reason).toBeNull();
  });
});
