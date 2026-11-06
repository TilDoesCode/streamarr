import type { LocalSource } from '@/player/controller-types';
import { TICKS_PER_SECOND, type Playback } from '@/player/playback-api';

/** Subtitles the saved engine shows from the file itself; the rest would need the server. */
const LOCAL_SUBTITLES = new Set(['embedded', 'webvtt']);

type Subtitle = NonNullable<NonNullable<Playback['mediaInfo']>['subtitleTracks']>[number];

/** The file's subtitles as `engine` shows them: VLC also renders the image ones (`vlcOnly`). */
function subtitlesFor(tracks: readonly Subtitle[], engine: 'native' | 'vlc'): Subtitle[] {
  return tracks.flatMap((track) => {
    if (engine === 'vlc' && track.vlcOnly) return [{ ...track, deliveredAs: 'embedded' }];
    return LOCAL_SUBTITLES.has(track.deliveredAs ?? '') ? [track] : [];
  });
}

/** A server-shaped "ready" playback for a downloaded file, so the controller and panels run unchanged. */
export function localPlayback(
  source: LocalSource,
  workId: string,
  now = Date.now(),
  engine: 'native' | 'vlc' = source.engine
): Playback {
  const info = source.mediaInfo;
  const stamp = new Date(now).toISOString();
  return {
    playbackId: `local-${source.downloadId}-${now.toString(36)}`,
    revision: 0,
    state: 'ready',
    workId,
    createdAt: stamp,
    updatedAt: stamp,
    attempts: [],
    version: source.version ?? null,
    method: 'direct',
    engine,
    url: source.uri,
    resumePositionTicks: Math.round(source.resumeSeconds * TICKS_PER_SECOND),
    mediaInfo: info
      ? {
          ...info,
          audioTracks: (info.audioTracks ?? []).map((track) => ({
            ...track,
            deliveredAs: 'original',
          })),
          subtitleTracks: subtitlesFor(info.subtitleTracks ?? [], engine),
        }
      : null,
  };
}

export const isLocalPlaybackId = (playbackId: string | null | undefined) =>
  !!playbackId?.startsWith('local-');
