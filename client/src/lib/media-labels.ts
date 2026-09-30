// Technical format names are identical in every language (not translations).
export const MEDIA_LABELS = {
  uhd: '4K',
  hdr10: 'HDR10',
  dolbyVision: 'Dolby Vision',
  atmos: 'Atmos',
} as const;

const VIDEO: Record<string, string> = {
  h264: 'H.264',
  avc: 'H.264',
  hevc: 'HEVC',
  h265: 'HEVC',
  av1: 'AV1',
  vp9: 'VP9',
  mpeg2: 'MPEG-2',
  mpeg2video: 'MPEG-2',
  mpeg4: 'MPEG-4',
  xvid: 'Xvid',
  vc1: 'VC-1',
};

const AUDIO: Record<string, string> = {
  aac: 'AAC',
  ac3: 'Dolby Digital',
  eac3: 'Dolby Digital+',
  truehd: 'TrueHD',
  dts: 'DTS',
  dtshd: 'DTS-HD',
  'dts-hd': 'DTS-HD',
  dtsx: 'DTS:X',
  flac: 'FLAC',
  opus: 'Opus',
  mp3: 'MP3',
  pcm: 'PCM',
  vorbis: 'Vorbis',
};

const HDR: Record<string, string> = {
  hdr10: MEDIA_LABELS.hdr10,
  'hdr10+': 'HDR10+',
  hdr10plus: 'HDR10+',
  dv: MEDIA_LABELS.dolbyVision,
  dolbyvision: MEDIA_LABELS.dolbyVision,
  'dolby-vision': MEDIA_LABELS.dolbyVision,
  hlg: 'HLG',
  hdr: 'HDR',
};

const label = (table: Record<string, string>, value: string) =>
  table[value.toLowerCase()] ?? value.toUpperCase();

export const videoCodecLabel = (codec: string) => label(VIDEO, codec);
export const audioCodecLabel = (codec: string) => label(AUDIO, codec);
export const hdrLabel = (format: string) => label(HDR, format);

/** 2160p → 4K; other heights stay as the release names them. */
export function resolutionLabel(resolution: string): string {
  return /^(2160|4k|uhd)/i.test(resolution) ? MEDIA_LABELS.uhd : resolution;
}
