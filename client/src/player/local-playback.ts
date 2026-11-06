import type { LocalSource } from '@/player/controller-types';
import { TICKS_PER_SECOND, type Playback } from '@/player/playback-api';

/** Subtitles the saved engine shows from the file itself; the rest would need the server. */
const LOCAL_SUBTITLES = new Set(['embedded', 'webvtt']);

/** A server-shaped "ready" playback for a downloaded file, so the controller and panels run unchanged. */
export function localPlayback(source: LocalSource, workId: string, now = Date.now()): Playback {
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
    engine: source.engine,
    url: source.uri,
    resumePositionTicks: Math.round(source.resumeSeconds * TICKS_PER_SECOND),
    mediaInfo: info
      ? {
          ...info,
          audioTracks: (info.audioTracks ?? []).map((track) => ({
            ...track,
            deliveredAs: 'original',
          })),
          subtitleTracks: (info.subtitleTracks ?? []).filter((track) =>
            LOCAL_SUBTITLES.has(track.deliveredAs ?? '')
          ),
        }
      : null,
  };
}

export const isLocalPlaybackId = (playbackId: string | null | undefined) =>
  !!playbackId?.startsWith('local-');
