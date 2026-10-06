import i18n from '@/i18n';
import playerDe from '@/i18n/locales/player.de.json';
import playerEn from '@/i18n/locales/player.en.json';
import { HINT_ACTIONS, HINT_KEYS, hintActionKey, hintText } from '@/player/recovery/hints';
import type { PlayerT } from '@/player/use-player-t';

const pt: PlayerT = (key, options) =>
  (i18n.t as unknown as (key: string, options: object) => string)(key, {
    ...options,
    ns: 'player',
  });

afterAll(() => i18n.changeLanguage('en'));

describe('status hints (state-matrix § 2 b.4)', () => {
  it('has exactly the catalogue keys in both languages', () => {
    const own = (table: Record<string, unknown>) =>
      Object.keys(table).filter((key) => typeof table[key] === 'string');
    expect(own(playerEn.hints).sort()).toEqual([...HINT_KEYS].sort());
    expect(own(playerDe.hints).sort()).toEqual([...HINT_KEYS].sort());
    expect(Object.keys(playerDe.hints.causes).sort()).toEqual(
      Object.keys(playerEn.hints.causes).sort()
    );
    expect(Object.keys(playerDe.hints.actions).sort()).toEqual(
      Object.keys(playerEn.hints.actions).sort()
    );
    expect(Object.keys(playerDe.hints.fallbacks)).toEqual(Object.keys(playerEn.hints.fallbacks));
  });

  it.each(['en', 'de'])('renders every hint and action with its params in %s', async (lng) => {
    await i18n.changeLanguage(lng);
    const params = {
      cause: 'call',
      measured: 3.1,
      needed: 8,
      seconds: 4,
      time: '1:12:04',
      format: 'HEVC',
      percent: 42,
      missing: '9 min',
      label: 'English (SDH)',
      device: 'Living room TV',
      releaseName: 'Sintel 2160p',
      reason: 'Password changed',
    };
    for (const key of HINT_KEYS) {
      const text = hintText(pt, key, params);
      expect(text).not.toMatch(/hints\.|\{|\}/);
      for (const action of HINT_ACTIONS[key])
        expect(pt(hintActionKey(action))).not.toMatch(/hints\./);
    }
    expect(hintText(pt, 'pausedBySystem', { cause: 'headphones' })).toBe(
      lng === 'en' ? 'Paused: headphones disconnected.' : 'Pausiert: Kopfhörer getrennt.'
    );
    expect(hintText(pt, 'slowNet', { measured: 3.1, needed: 8 })).toContain(
      '3.1'.replace('.', lng === 'de' ? ',' : '.')
    );
  });
});
