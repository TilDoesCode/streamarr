import { primaryLanguage } from '@/player/audio-renditions';

type Track = { index: number; language?: string | null; forced?: boolean | null };

const SAME_LANGUAGE: Record<string, string> = {
  de: 'ger',
  deu: 'ger',
  en: 'eng',
  fr: 'fre',
  fra: 'fre',
  es: 'spa',
  it: 'ita',
  nl: 'dut',
  nld: 'dut',
  ja: 'jpn',
  pt: 'por',
  ru: 'rus',
  zh: 'chi',
  zho: 'chi',
  cs: 'cze',
  ces: 'cze',
  pl: 'pol',
  sv: 'swe',
  da: 'dan',
  no: 'nor',
  fi: 'fin',
  tr: 'tur',
  ko: 'kor',
};

function languageKey(code: string | null | undefined): string {
  const primary = primaryLanguage(code);
  return SAME_LANGUAGE[primary] ?? primary;
}

/** Subtitle after an audio switch (server `subtitleMode: forced`): forced/none follows the audio, a full one stays. */
export function subtitleAfterAudio(
  subtitles: readonly Track[],
  current: number | null,
  audioLanguage: string | null | undefined,
  mode: string | null | undefined
): number | null {
  const shown = current === null ? undefined : subtitles.find((track) => track.index === current);
  if (shown && !shown.forced) return current;
  if (!shown && (mode ?? 'forced') !== 'forced') return current;
  const forced = subtitles.filter((track) => track.forced);
  const language = languageKey(audioLanguage);
  const match =
    (language && forced.find((track) => languageKey(track.language) === language)) ||
    forced.find((track) => !languageKey(track.language));
  return match?.index ?? null;
}
