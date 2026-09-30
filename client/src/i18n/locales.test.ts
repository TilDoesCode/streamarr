import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';

import de from './locales/de.json';
import en from './locales/en.json';
import playerDe from './locales/player.de.json';
import playerEn from './locales/player.en.json';

type Table = Record<string, unknown>;

function leaves(table: Table, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(table)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out[path] = value;
    else if (value && typeof value === 'object') Object.assign(out, leaves(value as Table, path));
    else out[path] = `<${typeof value}>`;
  }
  return out;
}

const KIND: Partial<Record<TYPE, string>> = {
  [TYPE.argument]: 'argument',
  [TYPE.number]: 'number',
  [TYPE.date]: 'date',
  [TYPE.time]: 'time',
  [TYPE.plural]: 'plural',
  [TYPE.select]: 'select',
};

/** ICU arguments of a message as "name:kind", including those nested in plural/select branches. */
function argumentsOf(elements: MessageFormatElement[], out = new Set<string>()): Set<string> {
  for (const element of elements) {
    const kind = KIND[element.type];
    if (kind && 'value' in element) out.add(`${element.value}:${kind}`);
    if (element.type === TYPE.plural || element.type === TYPE.select) {
      for (const option of Object.values(element.options)) argumentsOf(option.value, out);
    }
    if (element.type === TYPE.tag) argumentsOf(element.children, out);
  }
  return out;
}

function pluralsWithoutOther(elements: MessageFormatElement[]): number {
  return elements.reduce((missing, element) => {
    if (element.type === TYPE.plural || element.type === TYPE.select) {
      const own = 'other' in element.options ? 0 : 1;
      return (
        missing +
        own +
        Object.values(element.options).reduce(
          (m, option) => m + pluralsWithoutOther(option.value),
          0
        )
      );
    }
    return missing;
  }, 0);
}

const tables = {
  en: leaves({ translation: en, player: playerEn }),
  de: leaves({ translation: de, player: playerDe }),
};

describe('locales', () => {
  it('de and en have exactly the same keys', () => {
    expect(Object.keys(tables.de).sort()).toEqual(Object.keys(tables.en).sort());
  });

  it.each(Object.entries(tables))('%s: every message is valid ICU MessageFormat', (_, table) => {
    const invalid = Object.entries(table).flatMap(([key, message]) => {
      try {
        parse(message);
        return [];
      } catch (error) {
        return [`${key}: ${(error as Error).message}`];
      }
    });
    expect(invalid).toEqual([]);
  });

  it('de and en use the same ICU arguments (name and kind) per key', () => {
    const mismatches = Object.keys(tables.en).flatMap((key) => {
      const a = [...argumentsOf(parse(tables.en[key]!))].sort();
      const b = [...argumentsOf(parse(tables.de[key] ?? ''))].sort();
      return JSON.stringify(a) === JSON.stringify(b) ? [] : [`${key}: en ${a} / de ${b}`];
    });
    expect(mismatches).toEqual([]);
  });

  it.each(Object.entries(tables))(
    '%s: plural/select messages have an `other` branch',
    (_, table) => {
      const missing = Object.entries(table)
        .filter(([, message]) => pluralsWithoutOther(parse(message)) > 0)
        .map(([key]) => key);
      expect(missing).toEqual([]);
    }
  );

  it.each(Object.entries(tables))('%s: no empty or non-string values', (_, table) => {
    const bad = Object.entries(table)
      .filter(([, message]) => message.trim() === '' || /^<\w+>$/.test(message))
      .map(([key]) => key);
    expect(bad).toEqual([]);
  });

  it('does not use i18next {{double brace}} interpolation (ICU uses {single})', () => {
    const legacy = [...Object.entries(tables.en), ...Object.entries(tables.de)]
      .filter(([, message]) => /{{\s*\w+\s*}}/.test(message))
      .map(([key]) => key);
    expect(legacy).toEqual([]);
  });
});
