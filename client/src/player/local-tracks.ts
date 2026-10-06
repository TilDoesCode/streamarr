import { engineTrackFor, renditionFor, renditionOfTrack } from '@/player/audio-renditions';
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

type Track = EngineTracks['audio'][number];

/** The server audio track playing now, as the engine reports it (rendition, local track or the server's pick). */
export function currentAudioOf(
  playback: Playback | null,
  engineTracks: readonly Track[]
): number | null {
  const list = playback?.mediaInfo?.audioTracks ?? [];
  const renditions = playback?.inSessionAudioSwitch ? (playback.audioRenditions ?? []) : [];
  const heard = engineTracks.find((track) => track.selected);
  if (renditions.length && heard) {
    const rendition = renditionOfTrack(heard, renditions, engineTracks);
    if (rendition) return rendition.streamIndex;
  }
  const local = list.every((track) => track.deliveredAs === 'original');
  if (local && engineTracks.length === list.length) {
    const at = engineTracks.findIndex((track) => track.selected);
    if (at >= 0) return list[at]?.index ?? null;
  }
  return list.find((track) => track.selected)?.index ?? null;
}

/** The server subtitle shown now; a forced one AVPlayer shows by itself stays the viewer's unless they turned it off. */
export function currentSubtitleOf(
  playback: Playback | null,
  engineTracks: EngineTracks['subtitles'],
  turnedOff: boolean
): number | null {
  const list = playback?.mediaInfo?.subtitleTracks ?? [];
  const burned = list.find((track) => track.selected && track.deliveredAs === 'burnedIn');
  if (burned) return burned.index;
  const local = list.filter((track) => LOCAL_SUBTITLES.has(track.deliveredAs ?? ''));
  const at = engineTracks.findIndex((track) => track.selected);
  const forced = list.find((track) => track.selected && track.forced);
  if (at < 0 && forced && !turnedOff) return forced.index;
  if (engineTracks.length >= local.length && local.length) return local[at]?.index ?? null;
  return list.find((track) => track.selected)?.index ?? null;
}
