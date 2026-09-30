import type { TFunction } from 'i18next';

const GENERIC = /^(season|staffel)\s+\d+$/i;

/** The server's season name, localized when it is the generic "Season N" (or missing). */
export function seasonName(t: TFunction, name: string | null | undefined, season: number): string {
  if (!name || GENERIC.test(name.trim())) return t('media.season', { season });
  return name;
}
