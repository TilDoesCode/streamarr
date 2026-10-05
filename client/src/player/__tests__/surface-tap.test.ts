import { webSurfaceTap } from '@/player/surface-tap';

describe('web surface tap (F8 V2: Mobile Safari first tap)', () => {
  it('a touch on hidden controls only shows them', () => {
    expect(webSurfaceTap(false, 'touch')).toBe('show');
    expect(webSurfaceTap(false, null)).toBe('show');
  });

  it('a touch on visible controls and any mouse click toggle playback', () => {
    expect(webSurfaceTap(true, 'touch')).toBe('toggle');
    expect(webSurfaceTap(false, 'mouse')).toBe('toggle');
  });
});
