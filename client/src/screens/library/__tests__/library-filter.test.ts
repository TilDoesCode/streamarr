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
