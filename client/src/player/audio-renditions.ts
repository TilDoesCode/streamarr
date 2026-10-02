import type { EngineTrack } from './engines/types';
import type { Playback } from './playback-api';

export type AudioRendition = NonNullable<Playback['audioRenditions']>[number];

/** "de-DE" / "DE" → "de"; empty for missing or undetermined languages. */
export function primaryLanguage(code: string | null | undefined): string {
  const primary = (code ?? '').trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return primary === 'und' ? '' : primary;
}

/** The rendition that delivers server audio track `streamIndex` in this session, if any. */
export function renditionFor(
  playback: Playback | null | undefined,
  streamIndex: number
): AudioRendition | undefined {
  if (!playback?.inSessionAudioSwitch) return undefined;
  const track = playback.mediaInfo?.audioTracks?.find((item) => item.index === streamIndex);
  if (!track?.renditionId) return undefined;
  return (playback.audioRenditions ?? []).find((item) => item.id === track.renditionId);
}

/**
 * Engine track that plays `rendition`: the same NAME, else the only track in its language, else the same
 * position in the master when the engine lists exactly the master's renditions.
 */
export function engineTrackFor(
  rendition: AudioRendition,
  renditions: readonly AudioRendition[],
  tracks: readonly EngineTrack[]
): EngineTrack | undefined {
  const byLabel = tracks.filter((track) => !!rendition.label && track.label === rendition.label);
  if (byLabel.length === 1) return byLabel[0];
  const language = primaryLanguage(rendition.language);
  const sameLanguage = (list: readonly EngineTrack[]) =>
    language ? list.filter((track) => primaryLanguage(track.language) === language) : [];
  const byLanguage = sameLanguage(byLabel.length ? byLabel : tracks);
  if (byLanguage.length === 1) return byLanguage[0];
  const siblings = renditions.filter((item) => primaryLanguage(item.language) === language);
  if (byLanguage.length > 1 && siblings.length === byLanguage.length)
    return byLanguage[siblings.indexOf(rendition)];
  if (tracks.length !== renditions.length) return undefined;
  const at = renditions.indexOf(rendition);
  const candidate = tracks[at];
  // Index order only when the engine does not contradict it with another language.
  const other = primaryLanguage(candidate?.language);
  return candidate && (!other || !language || other === language) ? candidate : undefined;
}

/** Inverse of `engineTrackFor`: the rendition the engine currently plays. */
export function renditionOfTrack(
  track: EngineTrack,
  renditions: readonly AudioRendition[],
  tracks: readonly EngineTrack[]
): AudioRendition | undefined {
  return renditions.find((rendition) => engineTrackFor(rendition, renditions, tracks) === track);
}
