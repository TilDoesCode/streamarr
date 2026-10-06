import { renditionFor } from '@/player/audio-renditions';
import type { EngineTracks, PlayerEngine } from '@/player/engines/types';
import type { Playback } from '@/player/playback-api';
import type { StepTracks } from '@/player/recovery/runner';
import { LOCAL_SUBTITLES } from '@/player/local-tracks';

/** How often a new source re-applies the server's track picks over the engine's own choice. */
const MAX_SERVER_TRACK_APPLIES = 3;
/** The engine has settled its own picks by then. */
const FOLLOW_MS = 15_000;

export type ServerTracksHost = {
  localTrackId(kind: 'audio' | 'subtitle', index: number, tracks: EngineTracks): string | null;
  /** The playback is still the one these tracks belong to. */
  current(): boolean;
  ended(): void;
};

/** Puts the server's (or the viewer's) audio and subtitle over the engine's own picks on a new source; returns the stop. */
export function followServerTracks(
  engine: PlayerEngine,
  playback: Playback,
  viewer: StepTracks | null,
  host: ServerTracksHost
): () => void {
  const info = playback.mediaInfo;
  const local = (info?.subtitleTracks ?? []).filter((track) =>
    LOCAL_SUBTITLES.has(track.deliveredAs ?? '')
  );
  // A reload keeps what the viewer picked in the engine (audio, subtitles, a forced track that followed the audio).
  const audio = info?.audioTracks?.find((track) =>
    viewer?.audio != null ? track.index === viewer.audio : track.selected
  );
  const subtitle = local.find((track) =>
    viewer ? track.index === viewer.subtitle : track.selected
  );
  const rendition = audio ? renditionFor(playback, audio.index) : undefined;
  const expectAudio = audio?.deliveredAs === 'original' || !!rendition;
  const audioCount = rendition
    ? (playback.audioRenditions?.length ?? 0)
    : (info?.audioTracks?.length ?? 0);
  let subtitleId: string | null | undefined;
  let subtitleApplied = 0;
  let audioApplied = 0;
  // Safari, AVPlayer and ExoPlayer may still pick by system or audio language: re-apply until the viewer picks.
  const unsubscribe = engine.subscribe((event) => {
    if (event.type !== 'tracks' || !host.current()) return;
    const { tracks } = event;
    if (subtitleId === undefined && tracks.subtitles.length >= local.length)
      subtitleId = subtitle ? host.localTrackId('subtitle', subtitle.index, tracks) : null;
    const shown = tracks.subtitles.find((track) => track.selected)?.id ?? null;
    if (
      subtitleId !== undefined &&
      subtitleId !== shown &&
      (subtitleId !== null || local.length) &&
      subtitleApplied < MAX_SERVER_TRACK_APPLIES
    ) {
      subtitleApplied += 1;
      engine.setSubtitleTrack(subtitleId);
    }
    if (expectAudio && tracks.audio.length < audioCount) return;
    const audioId = expectAudio && audio ? host.localTrackId('audio', audio.index, tracks) : null;
    if (audioId === null) return subtitleId !== undefined && !local.length ? done() : undefined;
    if (audioApplied >= MAX_SERVER_TRACK_APPLIES) return done();
    if (!tracks.audio.find((track) => track.id === audioId)?.selected) {
      audioApplied += 1;
      engine.setAudioTrack(audioId);
    }
  });
  const timer = setTimeout(() => done(), FOLLOW_MS);
  const done = () => {
    unsubscribe();
    clearTimeout(timer);
    host.ended();
  };
  return done;
}
