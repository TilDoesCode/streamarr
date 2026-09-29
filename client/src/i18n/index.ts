import './polyfills';

import { getLocales, useLocales } from 'expo-localization';
import { createInstance } from 'i18next';
import ICU from 'i18next-icu';
import { useEffect, useSyncExternalStore } from 'react';
import { initReactI18next } from 'react-i18next';
import { Platform } from 'react-native';

import {
  readLanguagePreference,
  resolveLanguage,
  subscribeLanguagePreference,
  writeLanguagePreference,
  type Language,
  type LanguagePreference,
} from './languages';
import de from './locales/de.json';
import en from './locales/en.json';

export {
  LANGUAGE_PREFERENCES,
  SUPPORTED_LANGUAGES,
  type Language,
  type LanguagePreference,
} from './languages';

export const resources = { en: { translation: en }, de: { translation: de } } as const;

const i18n = createInstance();

void i18n
  .use(
    new ICU({
      parseErrorHandler: (error: Error, key: string, message: string) => {
        if (__DEV__) console.warn(`[i18n] ICU error in "${key}": ${error.message}`);
        return message;
      },
    })
  )
  .use(initReactI18next)
  .init({
    resources,
    lng: resolveLanguage(readLanguagePreference(), getLocales()),
    fallbackLng: 'en',
    supportedLngs: ['en', 'de'],
    interpolation: { escapeValue: false },
  });

function syncDocumentLanguage(lng: string) {
  if (Platform.OS === 'web' && typeof document !== 'undefined') document.documentElement.lang = lng;
}
syncDocumentLanguage(i18n.language);
i18n.on('languageChanged', syncDocumentLanguage);

export function currentLanguage(): Language {
  return i18n.language === 'de' ? 'de' : 'en';
}

/** Stores the per-device override ('system' clears it) and switches the UI language. */
export async function setLanguagePreference(preference: LanguagePreference): Promise<void> {
  writeLanguagePreference(preference);
  await i18n.changeLanguage(resolveLanguage(preference, getLocales()));
}

export function useLanguagePreference(): LanguagePreference {
  return useSyncExternalStore(
    subscribeLanguagePreference,
    readLanguagePreference,
    readLanguagePreference
  );
}

/** Follows device language changes while the preference is 'system'. Mount once at the root. */
export function useDeviceLanguageSync(): void {
  const locales = useLocales();
  const preference = useLanguagePreference();
  useEffect(() => {
    const next = resolveLanguage(preference, locales);
    if (next !== i18n.language) void i18n.changeLanguage(next);
  }, [locales, preference]);
}

export default i18n;
