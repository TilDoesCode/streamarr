import type { Playback, PlaybackPreferences } from '@/player/playback-api';

/** Two-letter and three-letter codes of one language compare equal ("de" = "ger" = "deu"). */
const ALIASES: Record<string, string> = {
  ger: 'de',
  deu: 'de',
  eng: 'en',
  fre: 'fr',
  fra: 'fr',
  spa: 'es',
  ita: 'it',
  jpn: 'ja',
  dut: 'nl',
  nld: 'nl',
  chi: 'zh',
  zho: 'zh',
  cze: 'cs',
  ces: 'cs',
  gre: 'el',
  ell: 'el',
  rum: 'ro',
  ron: 'ro',
  slo: 'sk',
  slk: 'sk',
};
const key = (code: string | null | undefined) => {
  const lower = (code ?? '').toLowerCase();
  return ALIASES[lower] ?? lower;
};
/** Undetermined, multiple, no linguistic content, missing: never a preference, never named in a notice (S4n). */
const NO_LANGUAGE = new Set(['', 'und', 'mul', 'zxx', 'mis']);
const language = (code: string | null | undefined) =>
  NO_LANGUAGE.has(key(code)) ? undefined : (code ?? undefined);

export type ViewerLanguages = {
  audio?: string;
  subtitle?: string;
  /** A forced subtitle shown now: not a preference (it follows the audio), but named when the new version lacks it. */
  forced?: string;
  preferences: Partial<PlaybackPreferences>;
};

/** The viewer's audio and (non-forced) subtitle language, as start preferences for another version (S9b2 D36). */
export function viewerLanguages(
  playback: Playback | null,
  audioIndex: number | null,
  subtitleIndex: number | null
): ViewerLanguages {
  const info = playback?.mediaInfo;
  const audio = language(info?.audioTracks?.find((track) => track.index === audioIndex)?.language);
  const subtitle = info?.subtitleTracks?.find((track) => track.index === subtitleIndex);
  const full = subtitle && !subtitle.forced ? language(subtitle.language) : undefined;
  const forced = subtitle?.forced ? language(subtitle.language) : undefined;
  return {
    audio,
    subtitle: full,
    ...(forced ? { forced } : {}),
    preferences: {
      ...(audio ? { audioLanguage: audio } : {}),
      ...(full ? { subtitleLanguage: full, subtitleMode: 'always' } : {}),
    },
  };
}

/** What the new version lacks of the viewer's languages: the notice says so (`noAudio`, `noSubtitle`). */
export function missingLanguages(
  wanted: ViewerLanguages,
  playback: Playback | null
): Record<string, string> {
  const info = playback?.mediaInfo;
  // A start answer without track lists says nothing about languages (S4n).
  if (!info) return {};
  const has = (list: { language?: string | null }[] | null | undefined, code: string) =>
    (list ?? []).some((track) => key(track.language) === key(code));
  // Only full subtitles count: a forced-only track is not "German subtitles" (S4n).
  const full = (info.subtitleTracks ?? []).filter((track) => !track.forced);
  return {
    ...(wanted.audio && !has(info.audioTracks, wanted.audio) ? { noAudio: wanted.audio } : {}),
    ...(wanted.subtitle && !has(full, wanted.subtitle) ? { noSubtitle: wanted.subtitle } : {}),
    // A forced subtitle (signs, foreign lines) the new version has in no form (S9c: dropped without a word).
    ...(wanted.forced && !has(info.subtitleTracks, wanted.forced)
      ? { noSubtitle: wanted.forced }
      : {}),
  };
}
