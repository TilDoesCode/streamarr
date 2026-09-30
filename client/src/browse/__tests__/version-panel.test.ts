import { entryIndex } from '@/browse/version-panel';

describe('version panel entry', () => {
  it('enters on the recommended card, else the first', () => {
    expect(entryIndex([{ recommended: false }, { recommended: true }])).toBe(1);
    expect(entryIndex([{ recommended: false }, { recommended: false }])).toBe(0);
    expect(entryIndex([])).toBe(0);
  });
});
