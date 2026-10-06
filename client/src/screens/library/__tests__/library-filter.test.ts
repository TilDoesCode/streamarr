import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Platform } from 'react-native';

import { applyLibraryFilter } from '@/screens/library/library-back';

describe('a genre or sort change on the Library page (F11)', () => {
  it.each(['web', 'ios', 'android'] as const)(
    '%s: replaces the page params (one Library entry; the URL keeps the filter), never pushes another page',
    (os) => {
      const platform = jest.replaceProperty(Platform, 'OS', os);
      const router = { setParams: jest.fn(), push: jest.fn(), replace: jest.fn() };
      applyLibraryFilter(router, { genre: '27', sort: 'top_rated' });
      expect(router.setParams).toHaveBeenCalledWith({ genre: '27', sort: 'top_rated' });
      expect(router.push).not.toHaveBeenCalled();
      expect(router.replace).not.toHaveBeenCalled();
      platform.restore();
    }
  );
});

describe('the Library screen changes its filter only through applyLibraryFilter (verify A2)', () => {
  it('no push or replace of its own: a web push that bypasses the helper fails here', () => {
    const source = readFileSync(join(__dirname, '../library-screen.tsx'), 'utf8');
    expect(source.match(/applyLibraryFilter\(router,/g)?.length).toBe(2);
    // Opening a title pushes its detail; nothing else on the page may push or replace a route.
    const routes = source.match(/router\.(push|replace|navigate)\([^)]*\)/g) ?? [];
    expect(routes).toEqual(['router.push(titleHref(item)']);
  });
});
