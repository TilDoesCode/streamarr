import { createInstance, type TFunction } from 'i18next';

import { certificationLabel, genreName, localizeDetail } from '@/browse/catalog-labels';
import de from '@/i18n/locales/de.json';
import en from '@/i18n/locales/en.json';

const fixedT = async (lng: 'de' | 'en'): Promise<TFunction> => {
  const instance = createInstance();
  await instance.init({ lng, resources: { de: { translation: de }, en: { translation: en } } });
  return instance.t;
};

describe('catalog labels in the app language (Q1-15)', () => {
  it('translates the TV genres TMDB leaves in English, keeps the rest', async () => {
    const t = await fixedT('de');
    expect(genreName('Sci-Fi & Fantasy', t)).toBe('Science-Fiction & Fantasy');
    expect(genreName('War & Politics', t)).toBe('Krieg & Politik');
    expect(genreName('Krimi', t)).toBe('Krimi');
    expect(genreName('Sci-Fi & Fantasy', await fixedT('en'))).toBe('Sci-Fi & Fantasy');
  });

  it('hides "NR" / "Not Rated", keeps real ratings', () => {
    expect(certificationLabel('NR')).toBeNull();
    expect(certificationLabel(' Not Rated ')).toBeNull();
    expect(certificationLabel('')).toBeNull();
    expect(certificationLabel('FSK 12')).toBe('FSK 12');
    expect(certificationLabel('TV-14')).toBe('TV-14');
  });

  it('localizes a detail response once for every screen', async () => {
    const t = await fixedT('de');
    expect(
      localizeDetail({ title: 'x', genres: ['Drama', 'Sci-Fi & Fantasy'], certification: 'NR' }, t)
    ).toEqual({ title: 'x', genres: ['Drama', 'Science-Fiction & Fantasy'], certification: null });
  });
});
