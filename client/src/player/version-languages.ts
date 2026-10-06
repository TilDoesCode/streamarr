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
};
const key = (code: string | null | undefined) => {
  const lower = (code ?? '').toLowerCase();
  return ALIASES[lower] ?? lower;
};

export type ViewerLanguages = {
  audio?: string;
  subtitle?: string;
  preferences: Partial<PlaybackPreferences>;
};

/** The viewer's audio and (non-forced) subtitle language, as start preferences for another version (S9b2 D36). */
export function viewerLanguages(
  playback: Playback | null,
  audioIndex: number | null,
  subtitleIndex: number | null
): ViewerLanguages {
  const info = playback?.mediaInfo;
  const audio =
    info?.audioTracks?.find((track) => track.index === audioIndex)?.language ?? undefined;
  const subtitle = info?.subtitleTracks?.find((track) => track.index === subtitleIndex);
  const full = subtitle && !subtitle.forced ? (subtitle.language ?? undefined) : undefined;
  return {
    audio,
    subtitle: full,
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
  const has = (list: { language?: string | null }[] | null | undefined, code: string) =>
    (list ?? []).some((track) => key(track.language) === key(code));
  return {
    ...(wanted.audio && !has(info?.audioTracks, wanted.audio) ? { noAudio: wanted.audio } : {}),
    ...(wanted.subtitle && !has(info?.subtitleTracks, wanted.subtitle)
      ? { noSubtitle: wanted.subtitle }
      : {}),
  };
}
