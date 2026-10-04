import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import en from './locales/en.json';
import playerEn from './locales/player.en.json';

const SRC = join(__dirname, '..');

function leaves(table: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(table).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return value && typeof value === 'object'
      ? leaves(value as Record<string, unknown>, path)
      : [path];
  });
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'locales' ? [] : sources(path);
    return /\.tsx?$/.test(name) && !/\.(test|d)\.tsx?$/.test(name) ? [path] : [];
  });
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A key counts as used when it appears quoted, or a quoted prefix is completed at runtime (`rows.${id}`, 'a.' + b). */
function isUsed(key: string, code: string): boolean {
  if (new RegExp(`['"\`]${escape(key)}['"\`]`).test(code)) return true;
  const parts = key.split('.');
  return parts.slice(1).some((_, index) => {
    const prefix = `${parts.slice(0, index + 1).join('.')}.`;
    return new RegExp(`['"\`]${escape(prefix)}(\\$\\{|['"]\\s*\\+)`).test(code);
  });
}

describe('locale keys', () => {
  const code = sources(SRC)
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');

  it('detects literal and runtime-completed keys (self-check)', () => {
    expect(isUsed('a.b', "t('a.b')")).toBe(true);
    expect(isUsed('rows.top', 't(`rows.${id}`)')).toBe(true);
    expect(isUsed('rows.top', "t('rows.' + id)")).toBe(true);
    expect(isUsed('a.b', "t('a.bc')")).toBe(false);
    expect(isUsed('a.b', "t('x.a.b')")).toBe(false);
  });

  it.each([
    ['translation', leaves(en)],
    ['player', leaves(playerEn)],
  ])('every %s key is used in src', (_, keys) => {
    expect(keys.filter((key) => !isUsed(key, code))).toEqual([]);
  });
});
