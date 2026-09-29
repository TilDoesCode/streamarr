import type { Locale } from 'expo-localization';

import { deviceSettings } from '@/lib/storage';

export const SUPPORTED_LANGUAGES = ['en', 'de'] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];
export type LanguagePreference = 'system' | Language;

export const LANGUAGE_PREFERENCES: readonly LanguagePreference[] = [
  'system',
  ...SUPPORTED_LANGUAGES,
];

const STORAGE_KEY = 'language';

export function isLanguage(value: unknown): value is Language {
  return SUPPORTED_LANGUAGES.includes(value as Language);
}

/** First device locale we support, in the user's order of preference; English otherwise. */
export function detectDeviceLanguage(locales: Pick<Locale, 'languageCode'>[]): Language {
  for (const locale of locales) {
    const code = locale.languageCode?.toLowerCase();
    if (isLanguage(code)) return code;
  }
  return 'en';
}

export function resolveLanguage(
  preference: LanguagePreference,
  locales: Pick<Locale, 'languageCode'>[]
): Language {
  return preference === 'system' ? detectDeviceLanguage(locales) : preference;
}

export function readLanguagePreference(): LanguagePreference {
  const stored = deviceSettings.getString(STORAGE_KEY);
  return isLanguage(stored) ? stored : 'system';
}

export function writeLanguagePreference(preference: LanguagePreference): void {
  if (preference === 'system') deviceSettings.remove(STORAGE_KEY);
  else deviceSettings.set(STORAGE_KEY, preference);
}

export function subscribeLanguagePreference(onChange: () => void): () => void {
  const listener = deviceSettings.addOnValueChangedListener((key) => {
    if (key === STORAGE_KEY) onChange();
  });
  return () => listener.remove();
}
