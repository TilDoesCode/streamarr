/* eslint-disable @typescript-eslint/no-require-imports -- conditional polyfills must load lazily */
import { shouldPolyfill as shouldPolyfillLocale } from '@formatjs/intl-locale/should-polyfill.js';
import { shouldPolyfill as shouldPolyfillPluralRules } from '@formatjs/intl-pluralrules/should-polyfill.js';
import { IntlMessageFormat } from 'intl-messageformat';

// Hermes ships Intl.NumberFormat/DateTimeFormat but not Intl.Locale or Intl.PluralRules (ICU plurals).
if (shouldPolyfillLocale()) {
  require('@formatjs/intl-locale/polyfill-force.js');
}
if (shouldPolyfillPluralRules('de') || shouldPolyfillPluralRules('en')) {
  require('@formatjs/intl-pluralrules/polyfill-force.js');
  require('@formatjs/intl-pluralrules/locale-data/en.js');
  require('@formatjs/intl-pluralrules/locale-data/de.js');
}

// Every ICU message resolved its locale anew; on Android, Hermes answers supportedLocalesOf through ICU (JNI) each time.
const resolveLocale = IntlMessageFormat.resolveLocale;
const resolvedLocales = new Map<string, ReturnType<typeof resolveLocale>>();
IntlMessageFormat.resolveLocale = (locales) => {
  const key = String(locales);
  if (!resolvedLocales.has(key)) resolvedLocales.set(key, resolveLocale(locales));
  return resolvedLocales.get(key);
};
