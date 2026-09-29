import { deviceSettings } from '@/lib/storage';

import i18n, { currentLanguage, setLanguagePreference } from './index';
import {
  formatDate,
  formatDuration,
  formatFileSize,
  formatRelativeDay,
  formatRemaining,
} from './format';
import { detectDeviceLanguage, readLanguagePreference, resolveLanguage } from './languages';

const tFor = (lng: 'en' | 'de') => i18n.getFixedT(lng);

afterEach(async () => {
  await setLanguagePreference('en');
});

describe('language detection and override', () => {
  it('picks the first supported device language in the user’s order', () => {
    expect(detectDeviceLanguage([{ languageCode: 'fr' }, { languageCode: 'de' }])).toBe('de');
    expect(detectDeviceLanguage([{ languageCode: 'EN' }])).toBe('en');
    expect(detectDeviceLanguage([{ languageCode: 'ja' }])).toBe('en');
    expect(detectDeviceLanguage([])).toBe('en');
  });

  it('an explicit preference wins over the device language', () => {
    expect(resolveLanguage('system', [{ languageCode: 'de' }])).toBe('de');
    expect(resolveLanguage('en', [{ languageCode: 'de' }])).toBe('en');
  });

  it('stores the override per device and switches the UI language', async () => {
    await setLanguagePreference('de');
    expect(deviceSettings.getString('language')).toBe('de');
    expect(readLanguagePreference()).toBe('de');
    expect(currentLanguage()).toBe('de');
    expect(i18n.t('common.play')).toBe('Abspielen');

    await setLanguagePreference('system');
    expect(deviceSettings.getString('language')).toBeUndefined();
    expect(readLanguagePreference()).toBe('system');
  });

  it('ignores garbage in storage', () => {
    deviceSettings.set('language', 'klingon');
    expect(readLanguagePreference()).toBe('system');
  });
});

describe('ICU messages', () => {
  it('pluralizes with CLDR rules in both languages', () => {
    expect(tFor('en')('media.episodes', { count: 1 })).toBe('1 episode');
    expect(tFor('en')('media.episodes', { count: 12 })).toBe('12 episodes');
    expect(tFor('de')('media.episodes', { count: 1 })).toBe('1 Folge');
    expect(tFor('de')('media.episodes', { count: 3 })).toBe('3 Folgen');
    expect(tFor('en')('media.versions', { count: 0 })).toBe('No versions');
    expect(tFor('de')('format.relative.daysAgo', { count: 2 })).toBe('vor 2 Tagen');
  });

  it('formats numbers inside messages per locale', () => {
    expect(tFor('en')('a11y.progress', { progress: 0.42 })).toBe('42% watched');
    expect(tFor('de')('a11y.progress', { progress: 0.42 })).toMatch(/^42\s?% gesehen$/);
  });

  it('interpolates single-brace ICU arguments', () => {
    expect(tFor('en')('media.episodeCode', { season: 2, episode: 3 })).toBe('S2, E3');
    expect(tFor('de')('media.episodeCode', { season: 2, episode: 3 })).toBe('S2, F3');
  });
});

describe('formatters', () => {
  it('formats durations with localized units', () => {
    expect(formatDuration(35, tFor('en'))).toBe('35 s');
    expect(formatDuration(42 * 60, tFor('en'))).toBe('42 min');
    expect(formatDuration(90 * 60, tFor('en'))).toBe('1 h 30 min');
    expect(formatDuration(120 * 60, tFor('de'))).toBe('2 Std.');
    expect(formatDuration(102 * 60, tFor('de'))).toBe('1 Std. 42 Min.');
    expect(formatRemaining(37 * 60, tFor('de'))).toBe('Noch 37 Min.');
  });

  it('formats dates per locale (date-only strings stay on their calendar day)', () => {
    expect(formatDate('2010-07-25', 'en', 'long')).toBe('July 25, 2010');
    expect(formatDate('2010-07-25', 'de', 'long')).toBe('25. Juli 2010');
    expect(formatDate('2010-07-25', 'de', 'short')).toBe('25.7.2010');
  });

  it('formats relative days', () => {
    const now = new Date(2026, 8, 29, 12);
    expect(formatRelativeDay(new Date(2026, 8, 29, 1), 'en', tFor('en'), now)).toBe('Today');
    expect(formatRelativeDay(new Date(2026, 8, 28, 23), 'de', tFor('de'), now)).toBe('Gestern');
    expect(formatRelativeDay(new Date(2026, 8, 26), 'en', tFor('en'), now)).toBe('3 days ago');
    expect(formatRelativeDay(new Date(2026, 7, 1), 'en', tFor('en'), now)).toBe('Aug 1, 2026');
  });

  it('formats file sizes with locale decimals', () => {
    expect(formatFileSize(4_237_000_000, 'en', tFor('en'))).toBe('4.2 GB');
    expect(formatFileSize(4_237_000_000, 'de', tFor('de'))).toBe('4,2 GB');
    expect(formatFileSize(734_000_000, 'de', tFor('de'))).toBe('734 MB');
  });
});
