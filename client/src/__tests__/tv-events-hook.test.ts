import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..');
const HOOK = 'components/focus/use-tv-events.ts';

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

// react-native-tvos re-subscribes on every new handler identity; `useTVEvents` keeps one subscription (Q1-25, review S1).
describe('TV remote events', () => {
  it('go through the stable useTVEvents hook everywhere', () => {
    const direct = sources(SRC)
      .map((path) => relative(SRC, path))
      .filter((path) => path !== HOOK)
      .filter((path) => /\buseTVEventHandler\b/.test(readFileSync(join(SRC, path), 'utf8')));
    expect(direct).toEqual([]);
  });
});
