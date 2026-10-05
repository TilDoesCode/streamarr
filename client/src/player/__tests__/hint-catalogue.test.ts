import fs from 'fs';
import path from 'path';

import {
  buildCatalogue,
  catalogueTexts,
  NOT_STATES,
  SHARED_MESSAGES,
  SHARED_TEXTS,
} from '@/../jest/player/hint-catalogue';
import i18n from '@/i18n';
import playerEn from '@/i18n/locales/player.en.json';
import { noticeText } from '@/player/overlay-labels';

const FILE = path.join(__dirname, '../../../../docs/client/player/hint-catalogue.md');

const leaves = (value: unknown, prefix = ''): string[] =>
  typeof value === 'string'
    ? [prefix]
    : Object.entries(value as object).flatMap(([key, child]) =>
        leaves(child, prefix ? `${prefix}.${key}` : key)
      );

describe('player hint catalogue (S4h)', () => {
  it('docs/client/player/hint-catalogue.md is what the locale files say', () => {
    const built = buildCatalogue();
    if (process.env.UPDATE_CATALOGUE) fs.writeFileSync(FILE, built);
    expect(fs.readFileSync(FILE, 'utf8')).toBe(built);
  });

  it('every state text of the player namespace has a catalogue row', () => {
    const listed = new Set(catalogueTexts().map((text) => text.key));
    const missing = leaves(playerEn).filter(
      (key) =>
        !NOT_STATES.test(key) &&
        !listed.has(key) &&
        !/^(hints\.(causes|actions)|tried)\./.test(key) &&
        key !== 'tried.title'
    );
    expect(missing).toEqual([]);
  });

  it('no text uses jargon the viewer cannot act on', () => {
    const jargon =
      /\b(HLS|remux|T\d{1,2}|playbackId|ffmpeg|transcod\w*|Transkod\w*|decoder|Decoder|fallback|codec|segment|rendition)\b/i;
    const hits = catalogueTexts().flatMap(({ key, de, en }) =>
      [de, en].filter((text) => jargon.test(text)).map((text) => `${key}: ${text}`)
    );
    expect(hits).toEqual([]);
  });

  it('texts fit a TV card and a phone banner', () => {
    const limits: Record<string, number> = {
      start: 80,
      hint: 130,
      notice: 160,
      'card-title': 50,
      'card-message': 200,
    };
    const long = catalogueTexts().flatMap(({ layer, key, de, en }) =>
      [de, en]
        .filter((text) => text.length > (limits[layer] ?? 0))
        .map((text) => `${key} (${text.length})`)
    );
    expect(long).toEqual([]);
  });

  it('two states share a title only when the viewer does the same about them', () => {
    const titles = new Map<string, string[]>();
    for (const { layer, key, en } of catalogueTexts())
      if (layer === 'card-title') titles.set(en, [...(titles.get(en) ?? []), key]);
    const shared = [...titles].filter(([, keys]) => keys.length > 1).map(([text]) => text);
    expect(shared.sort()).toEqual(Object.keys(SHARED_TEXTS).sort());
  });

  it('no two different card messages read the same', () => {
    const seen = new Map<string, string>();
    const same: string[] = [];
    for (const { layer, key, en } of catalogueTexts()) {
      if (layer !== 'card-message') continue;
      const other = seen.get(en);
      if (other) same.push(`${other} = ${key}`);
      seen.set(en, key);
    }
    expect(same.map((pair) => pair.replace(/errors\.codes\.|\.message/g, ''))).toEqual(
      Object.keys(SHARED_MESSAGES)
    );
  });

  it('numbers follow the locale', () => {
    type Untyped = (key: string, options: Record<string, unknown>) => string;
    const de = i18n.getFixedT('de') as unknown as Untyped;
    const en = i18n.getFixedT('en') as unknown as Untyped;
    const slow = { measured: 2.4, needed: 12.5, ns: 'player' };
    expect(de('hints.slowNet', slow)).toContain('2,4 von 12,5 Mbit/s');
    expect(en('hints.slowNet', slow)).toContain('2.4 of 12.5 Mbit/s');
    expect(de('stepper.repairProgress', { percent: 0.42, ns: 'player' })).toMatch(
      /^42\s% repariert$/
    );
    expect(en('stepper.repairProgress', { percent: 0.42, ns: 'player' })).toBe('42% repaired');
  });

  it('a step-down notice says what happened first, then what the app did', () => {
    const pt = (key: string, options?: Record<string, unknown>) =>
      i18n.getFixedT('en')(
        key as never,
        { ...options, ns: 'player' } as never
      ) as unknown as string;
    const notice = { kind: 'stepDown', params: { to: 'transcode', reason: 'segment_timeout' } };
    expect(
      noticeText(
        notice,
        pt,
        () => '',
        () => ''
      )
    ).toBe('The video loaded too slowly. Switched to conversion on the server to keep playing.');
  });
});
