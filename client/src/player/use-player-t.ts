import { useTranslation } from 'react-i18next';

import type playerEn from '@/i18n/locales/player.en.json';

type Leaves<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

export type PlayerKey = Leaves<typeof playerEn>;
export type PlayerT = (key: PlayerKey, options?: Record<string, unknown>) => string;

type Untyped = (key: string, options?: Record<string, unknown>) => string;

/** Strings of the `player` namespace (kept out of the typed default namespace, which is at TypeScript's depth limit). */
export function usePlayerT(): PlayerT {
  const { t } = useTranslation();
  const untyped = t as unknown as Untyped;
  return (key, options) => untyped(key, { ...options, ns: 'player' });
}
