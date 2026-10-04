import { predictedMethod, type PredictedMethod } from '@/browse/version-format';
import type { Version } from '@/browse/queries';
import type { ErrorLike } from '@/api/error-text';
import { audioCodecLabel, hdrLabel, videoCodecLabel } from '@/lib/media-labels';

import type { AudioRendition } from './audio-renditions';
import type { Playback } from './playback-api';
import type { PlayerKey } from './use-player-t';

type Info = NonNullable<Playback['mediaInfo']>;
type Audio = NonNullable<Info['audioTracks']>[number];
type Video = NonNullable<Info['video']>;

/** Large player bar: text chips need ~960 pt; narrower windows (iPad mini/Air portrait) show icons only. */
export function barChipsLabelled(windowWidth: number, tv: boolean): boolean {
  return tv || windowWidth >= 960;
}

/** Large player title: up to 80 % of the bar (the Aurora 62 % cut "Die Hunde von Baskervi…" at 1280 px, Q1-13). */
export const LARGE_TITLE_MAX_WIDTH = '80%';

type Subtitle = NonNullable<Info['subtitleTracks']>[number];

const SUBTITLE_FORMATS: Readonly<Record<string, string>> = {
  subrip: 'SRT',
  srt: 'SRT',
  ass: 'ASS',
  ssa: 'SSA',
  webvtt: 'WebVTT',
  mov_text: 'Text',
  hdmv_pgs_subtitle: 'PGS',
  pgssub: 'PGS',
  dvd_subtitle: 'VobSub',
  dvdsub: 'VobSub',
  dvb_subtitle: 'DVB',
};

/** "subrip" → "SRT", "hdmv_pgs_subtitle" → "PGS"; unknown codecs upper-cased. */
export function subtitleFormat(codec: string | null | undefined): string {
  if (!codec) return '';
  return SUBTITLE_FORMATS[codec.toLowerCase()] ?? codec.toUpperCase();
}

/** Language in the app's words; the file's title only when nothing else (forced, format) tells two tracks apart. */
export function subtitleLabel(
  track: Subtitle,
  tracks: readonly Subtitle[],
  languageOf: (code: string) => string,
  fallback: string
): string {
  const language = track.language ? languageOf(track.language) : '';
  const twin = tracks.some(
    (other) =>
      other.index !== track.index &&
      other.language === track.language &&
      !!other.forced === !!track.forced &&
      subtitleFormat(other.codec) === subtitleFormat(track.codec)
  );
  if (language && !twin) return language;
  return [language, track.title].filter(Boolean).join(' · ') || fallback;
}

/** 6 → "5.1", 2 → "2.0", 1 → "1.0". */
export function channelLayout(channels: number | null | undefined): string {
  if (!channels) return '';
  if (channels >= 6) return `${channels - 1}.1`;
  return `${channels}.0`;
}

const isHdr = (range: string | null | undefined) =>
  !!range && !['sdr', 'none', ''].includes(range.toLowerCase());

/** 2160 → "4K", 1080 → "1080p"; HDR ranges add "HDR". */
export function qualityLabel(height: number | null | undefined, range?: string | null): string {
  const size = !height ? '' : height >= 2000 ? '4K' : `${height}p`;
  const hdr = isHdr(range) ? 'HDR' : '';
  return [size, hdr].filter(Boolean).join(' ');
}

function videoLine(codec: string | null | undefined, video: Video, height: number, hdr: boolean) {
  return [
    codec ? videoCodecLabel(codec) : '',
    video.bitDepth > 8 ? `${video.bitDepth}-bit` : '',
    // The format (`hdr`) names it; `videoRange` is the transfer and reads SDR on mistagged files.
    hdr ? hdrLabel((isHdr(video.hdr) ? video.hdr : video.videoRange) ?? '') : '',
    height ? `${height}p` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** "HEVC 10-bit HDR10 2160p → H.264 1080p SDR"; one side when nothing changes. */
export function videoTransfer(video: Video | null | undefined): string | null {
  if (!video) return null;
  const hdr = isHdr(video.videoRange) || isHdr(video.hdr);
  const source = videoLine(video.codec, video, video.height, hdr);
  const codecChanged = !!video.deliveredCodec && video.deliveredCodec !== video.codec;
  const heightChanged = !!video.deliveredHeight && video.deliveredHeight !== video.height;
  if (!codecChanged && !heightChanged) return source;
  const deliveredHeight = video.deliveredHeight ?? video.height;
  const delivered = [
    videoCodecLabel(video.deliveredCodec ?? video.codec ?? ''),
    deliveredHeight ? `${deliveredHeight}p` : '',
    hdr && codecChanged ? 'SDR' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `${source} → ${delivered}`;
}

/** What the player receives of a track: its session rendition, else the delivered (or source) format. */
function received(track: Audio, rendition?: AudioRendition | null) {
  return {
    codec: rendition?.codec || track.deliveredCodec || track.codec || '',
    channels: rendition?.channels || track.deliveredChannels || track.channels,
  };
}

const spec = (codec: string, channels: number | null | undefined) =>
  [codec ? audioCodecLabel(codec) : '', channelLayout(channels)].filter(Boolean).join(' ');

/** Layout the viewer hears ("2.0"): the audio chip and the audio panel use the same value. */
export function audioLayout(track: Audio, rendition?: AudioRendition | null): string {
  return channelLayout(received(track, rendition).channels);
}

/** "AAC 2.0": the format the viewer hears, the audio panel's description. */
export function audioSpec(track: Audio, rendition?: AudioRendition | null): string {
  const { codec, channels } = received(track, rendition);
  return spec(codec, channels);
}

/** "TrueHD 5.1 → AAC 2.0". */
export function audioTransfer(
  track: Audio | null | undefined,
  rendition?: AudioRendition | null
): string | null {
  if (!track) return null;
  const source = spec(track.codec ?? '', track.channels);
  const delivered = received(track, rendition);
  const changed =
    (!!delivered.codec && delivered.codec !== track.codec) ||
    (!!delivered.channels && delivered.channels !== track.channels);
  return changed ? `${source} → ${spec(delivered.codec, delivered.channels)}` : source;
}

/** "MKV → HLS" when the server repackages or converts. */
export function containerTransfer(
  container: string | null | undefined,
  method: string | null | undefined
): string | null {
  if (!container) return null;
  const source = container.toUpperCase();
  return method === 'remux' || method === 'transcode' ? `${source} → HLS` : source;
}

const RANK: Record<PredictedMethod, number> = {
  direct: 0,
  vlc: 1,
  remux: 2,
  transcode: 3,
  unknown: 4,
};

/** A version this device plays with less work than the current method (the info panel's hint). */
export function betterVersion(
  versions: readonly Version[],
  currentReleaseId: string | null | undefined,
  method: string | null | undefined
): Version | undefined {
  if (method !== 'remux' && method !== 'transcode') return undefined;
  const current = RANK[method];
  return versions
    .filter((version) => version.releaseId && version.releaseId !== currentReleaseId)
    .map((version) => ({ version, rank: RANK[predictedMethod(version) ?? 'unknown'] }))
    .filter((item) => item.rank < current && item.rank <= RANK.vlc)
    .sort((a, b) => a.rank - b.rank || (a.version.rank ?? 0) - (b.version.rank ?? 0))[0]?.version;
}

const STEP_DOWN_KEYS: Record<string, PlayerKey> = {
  direct: 'notice.stepDownDirect',
  remux: 'notice.stepDownRemux',
  transcode: 'notice.stepDownTranscode',
};

/** What the viewer sees after a step-down: what changed so playback continues, never raw method names. */
export function stepDownKey(params?: Readonly<Record<string, string>>): PlayerKey {
  if (params?.engine === 'vlc') return 'notice.stepDownVlc';
  return STEP_DOWN_KEYS[params?.to ?? ''] ?? 'notice.stepDown';
}

/** The error behind a `switchFailed` notice; the HTTP status picks the category text of an unknown code. */
export function noticeError(params?: Readonly<Record<string, string>>): ErrorLike {
  const status = params?.status;
  return {
    code: params?.code ?? 'unknown',
    status: status === undefined ? undefined : Number(status),
  };
}
