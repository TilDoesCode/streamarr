import { engineTrackFor, renditionFor } from '@/player/audio-renditions';
import type { EngineTracks } from '@/player/engines/types';
import type { Playback } from '@/player/playback-api';

/** Subtitle deliveries the engine renders itself (in the stream or as a sidecar WebVTT). */
export const LOCAL_SUBTITLES = new Set(['embedded', 'webvtt']);

/** Engine track that renders server track `index` locally, if the delivery allows it. */
export function localTrackId(
  playback: Playback | null,
  kind: 'audio' | 'subtitle',
  index: number,
  tracks: EngineTracks | undefined
): string | null {
  const info = playback?.mediaInfo;
  if (!info || !tracks) return null;
  if (kind === 'audio') {
    const list = info.audioTracks ?? [];
    const track = list.find((item) => item.index === index);
    const rendition = renditionFor(playback, index);
    if (rendition)
      return engineTrackFor(rendition, playback.audioRenditions ?? [], tracks.audio)?.id ?? null;
    if (track?.deliveredAs !== 'original') return null;
    return tracks.audio[list.indexOf(track)]?.id ?? null;
  }
  const list = (info.subtitleTracks ?? []).filter((item) =>
    LOCAL_SUBTITLES.has(item.deliveredAs ?? '')
  );
  const position = list.findIndex((item) => item.index === index);
  return position >= 0 ? (tracks.subtitles[position]?.id ?? null) : null;
}
