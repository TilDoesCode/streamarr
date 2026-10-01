import { predictedMethod, type PredictedMethod } from '@/browse/version-format';
import type { Version } from '@/browse/queries';
import { audioCodecLabel, hdrLabel, videoCodecLabel } from '@/lib/media-labels';

import type { Playback } from './playback-api';
import type { PlayerKey } from './use-player-t';

type Info = NonNullable<Playback['mediaInfo']>;
type Audio = NonNullable<Info['audioTracks']>[number];
type Video = NonNullable<Info['video']>;

/** Large player bar: text chips need ~960 pt; narrower windows (iPad mini/Air portrait) show icons only. */
export function barChipsLabelled(windowWidth: number, tv: boolean): boolean {
  return tv || windowWidth >= 960;
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
    hdr ? hdrLabel(video.videoRange ?? video.hdr ?? '') : '',
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

/** "TrueHD 5.1 → AAC 2.0". */
export function audioTransfer(track: Audio | null | undefined): string | null {
  if (!track) return null;
  const source = [track.codec ? audioCodecLabel(track.codec) : '', channelLayout(track.channels)]
    .filter(Boolean)
    .join(' ');
  const changed =
    (!!track.deliveredCodec && track.deliveredCodec !== track.codec) ||
    (!!track.deliveredChannels && track.deliveredChannels !== track.channels);
  if (!changed) return source;
  const delivered = [
    audioCodecLabel(track.deliveredCodec ?? track.codec ?? ''),
    channelLayout(track.deliveredChannels ?? track.channels),
  ]
    .filter(Boolean)
    .join(' ');
  return `${source} → ${delivered}`;
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
