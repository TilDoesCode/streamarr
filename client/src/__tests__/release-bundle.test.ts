/* eslint-disable @typescript-eslint/no-require-imports -- modules load in isolation with __DEV__ toggled */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('release bundle', () => {
  it('imports lucide icons one by one, never through the barrel of all icons', () => {
    const barrel = /import\s+(?!type\b)[^;]*?from\s+'lucide-react-native'/;
    const offenders = sourceFiles(SRC)
      .filter((path) => !path.endsWith(join('components', 'icons.ts')))
      .filter((path) => barrel.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path));
    expect(offenders).toEqual([]);
  });

  it('resolves every re-exported icon', () => {
    const icons = require('@/components/icons') as Record<string, unknown>;
    const names = Object.keys(icons);
    expect(names.length).toBeGreaterThan(40);
    expect(names.filter((name) => icons[name] == null)).toEqual([]);
  });

  it('loads no Intl polyfill on web', () => {
    const web = readFileSync(join(SRC, 'i18n', 'polyfills.web.ts'), 'utf8');
    expect(web).not.toMatch(/require\(|import /);
  });

  it.each([
    ['dev/gallery', '../app/dev/gallery', '../screens/gallery/gallery-screen', 'GalleryScreen'],
    [
      'dev/player',
      '../app/(app)/dev/player',
      '../screens/dev-player/dev-player-screen',
      'DevPlayerScreen',
    ],
  ])('serves %s only in dev builds', (_route, routePath, screenPath, screenName) => {
    const scope = globalThis as { __DEV__?: boolean };
    const dev = scope.__DEV__;
    try {
      scope.__DEV__ = false;
      jest.isolateModules(() => {
        const notFound = require('../app/+not-found').default;
        expect(require(routePath).default).toBe(notFound);
      });
      scope.__DEV__ = true;
      jest.isolateModules(() => {
        const screen = () => null;
        jest.doMock(screenPath, () => ({ [screenName]: screen }));
        expect(require(routePath).default).toBe(screen);
      });
    } finally {
      scope.__DEV__ = dev;
    }
  });
});
