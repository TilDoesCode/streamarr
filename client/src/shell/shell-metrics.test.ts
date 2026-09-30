import { isLargeShell, MIN_WEB_SCALE, SHELL, shellScale } from './shell-metrics';

describe('shell scale', () => {
  it('maps the 1920 layout onto the Android TV canvas', () => {
    expect(shellScale('tv', 960)).toBe(0.5);
    expect(shellScale('tv', 1920)).toBe(1);
  });

  it('is 1:1 on a 1920 wide desktop and keeps a floor on narrow windows', () => {
    expect(shellScale('desktop-web', 1920)).toBe(1);
    expect(shellScale('desktop-web', 1440)).toBe(0.75);
    expect(shellScale('tablet', 1024)).toBe(MIN_WEB_SCALE);
  });

  it('uses the large shell everywhere but on phones', () => {
    expect(isLargeShell('tv')).toBe(true);
    expect(isLargeShell('desktop-web')).toBe(true);
    expect(isLargeShell('tablet')).toBe(true);
    expect(isLargeShell('phone')).toBe(false);
  });

  it('keeps the mockup geometry', () => {
    expect(SHELL.row.left).toBe(SHELL.hero.copyLeft);
    expect(SHELL.landscape.width / SHELL.landscape.height).toBeCloseTo(16 / 9, 1);
    expect(SHELL.poster.height / SHELL.poster.width).toBe(1.5);
  });
});
