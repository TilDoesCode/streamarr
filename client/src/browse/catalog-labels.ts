import type { TFunction } from 'i18next';

// TMDB keeps these TV genre names in English for every language (e.g. "Sci-Fi & Fantasy" on de-DE).
const TV_GENRES = {
  'Sci-Fi & Fantasy': 'scifiFantasy',
  'War & Politics': 'warPolitics',
  'Action & Adventure': 'actionAdventure',
  Kids: 'kids',
  News: 'news',
  Reality: 'reality',
  Soap: 'soap',
  Talk: 'talk',
} as const;

/** A genre name in the app language: TMDB's untranslated TV genres get our own names. */
export function genreName(name: string, t: TFunction): string {
  const key = TV_GENRES[name as keyof typeof TV_GENRES];
  return key ? t(`genreNames.${key}`) : name;
}

/** The certification worth showing: "NR" / "Not Rated" is no rating at all, so it is hidden. */
export function certificationLabel(certification: string | null | undefined): string | null {
  const value = certification?.trim();
  return value && !/^(nr|not rated|unrated)$/i.test(value) ? value : null;
}

/** Catalog detail with genre names and certification as the UI shows them. */
export function localizeDetail<
  T extends { genres?: string[] | null; certification?: string | null },
>(detail: T, t: TFunction): T {
  return {
    ...detail,
    genres: detail.genres?.map((name) => genreName(name, t)) ?? detail.genres,
    certification: certificationLabel(detail.certification),
  };
}
