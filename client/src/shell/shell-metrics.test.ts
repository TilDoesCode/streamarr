import {
  isLargeShell,
  MIN_TEXT,
  MIN_WEB_SCALE,
  SHELL,
  shellFont,
  shellHeroFrame,
  shellScale,
  WEB_HERO,
  WEB_SHELL_SCALE,
} from './shell-metrics';

const WEB = { web: true } as const;
const scaler = (scale: number) => (value: number) => Math.round(value * scale * 2) / 2;

describe('shell scale', () => {
  it('maps the 1920 layout onto the TV screen exactly (Android TV 960 dp, Apple TV 1920 pt)', () => {
    expect(shellScale('tv', 960)).toBe(0.5);
    expect(shellScale('tv', 1920)).toBe(1);
    expect(shellScale('tv', 960, WEB)).toBe(0.5);
  });

  it('keeps native tablets on the width scale with a floor', () => {
    expect(shellScale('tablet', 1366)).toBeCloseTo(1366 / 1920);
    expect(shellScale('tablet', 1024)).toBe(MIN_WEB_SCALE);
  });

  it('uses one fixed scale on the web, independent of the window width', () => {
    for (const width of [640, 960, 1280, 1440, 1920, 2560, 2866, 3440, 5120]) {
      expect(shellScale('desktop-web', width, WEB)).toBe(WEB_SHELL_SCALE);
      expect(shellScale('tablet', width, WEB)).toBe(WEB_SHELL_SCALE);
    }
  });

  it('does not compensate browser zoom: CSS sizes stay equal, so physical sizes grow with the zoom', () => {
    const at100 = scaler(shellScale('desktop-web', 1920, WEB));
    for (const zoom of [0.67, 1.5, 2]) {
      const cssWidth = Math.round(1920 / zoom);
      const s = scaler(shellScale('desktop-web', cssWidth, WEB));
      expect(s(SHELL.type.heroTitle)).toBe(at100(SHELL.type.heroTitle));
      expect(s(SHELL.poster.width)).toBe(at100(SHELL.poster.width));
      expect(s(SHELL.type.rowTitle) * zoom).toBeCloseTo(at100(SHELL.type.rowTitle) * zoom);
    }
    const s150 = scaler(shellScale('desktop-web', 1280, WEB));
    expect(s150(SHELL.type.rowTitle) * 1.5).toBeGreaterThan(at100(SHELL.type.rowTitle));
  });

  it('gives desktop sizes at arm length instead of the 10-foot ones', () => {
    const s = scaler(WEB_SHELL_SCALE);
    expect(s(SHELL.type.heroTitle)).toBe(52);
    expect(s(SHELL.type.rowTitle)).toBe(23);
    expect(s(SHELL.type.cardTitle)).toBe(16);
    expect(s(SHELL.poster.width)).toBe(150);
  });

  it('follows the browser default font size within bounds', () => {
    expect(shellScale('desktop-web', 1920, { web: true, textScale: 1.25 })).toBe(
      WEB_SHELL_SCALE * 1.25
    );
    expect(shellScale('desktop-web', 1920, { web: true, textScale: 9 })).toBe(WEB_SHELL_SCALE * 2);
    expect(shellScale('desktop-web', 1920, { web: true, textScale: Number.NaN })).toBe(
      WEB_SHELL_SCALE
    );
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

  it('keeps chips and captions readable on a 1024 px tablet but scales TV exactly', () => {
    const tablet = shellScale('tablet', 1024);
    expect(shellFont('tablet', tablet, SHELL.type.spec, MIN_TEXT.spec)).toBeGreaterThanOrEqual(11);
    expect(
      shellFont('tablet', tablet, SHELL.type.cardTitle, MIN_TEXT.caption)
    ).toBeGreaterThanOrEqual(15);
    expect(shellFont('tv', 0.5, SHELL.type.spec, MIN_TEXT.spec)).toBe(SHELL.type.spec / 2);
  });
});

describe('shellHeroFrame', () => {
  it('keeps the mockup frame on TV at any height', () => {
    expect(shellHeroFrame('tv', scaler(0.5), { width: 960, height: 400 })).toEqual({
      heroHeight: 330,
      rowsTop: 324,
      backdropWidth: 750,
      copyAnchor: 'top',
    });
    expect(shellHeroFrame('tv', scaler(1), { width: 1920, height: 1080 })).toEqual({
      heroHeight: 660,
      rowsTop: 648,
      backdropWidth: 1500,
      copyAnchor: 'top',
    });
  });

  it('native tablet: hero and rows keep their 1080p share of the height (Q1-22)', () => {
    const tablet = scaler(shellScale('tablet', 1024));
    expect(shellHeroFrame('tablet', tablet, { width: 1024, height: 1366 })).toEqual({
      heroHeight: tablet(660),
      rowsTop: tablet(648),
      backdropWidth: tablet(1500),
      copyAnchor: 'top',
    });
    const short = shellHeroFrame('tablet', scaler(0.7), { width: 1366, height: 600 });
    expect(short.heroHeight / 600).toBeLessThanOrEqual(SHELL.hero.height / SHELL.height);
  });

  describe('web', () => {
    const s = scaler(WEB_SHELL_SCALE);
    const frame = (width: number, height: number) =>
      shellHeroFrame('desktop-web', s, { width, height }, true);

    it('never shrinks the artwork below the mockup and keeps the row overlap', () => {
      const small = frame(1280, 800);
      expect(small.backdropWidth).toBe(s(SHELL.hero.backdropWidth));
      expect(small.heroHeight).toBeLessThanOrEqual(800 * WEB_HERO.heightShare);
      expect(small.heroHeight - small.rowsTop).toBe(s(SHELL.hero.height) - s(SHELL.row.top));
      expect(small.copyAnchor).toBe('bottom');
    });

    it('widens the artwork with the window and caps the hero share of the height', () => {
      const hd = frame(1920, 1080);
      const qhd = frame(2560, 1440);
      const ultrawide = frame(3440, 1440);
      expect(qhd.backdropWidth).toBeGreaterThan(hd.backdropWidth);
      expect(ultrawide.backdropWidth).toBe(Math.round(3440 * WEB_HERO.widthShare));
      expect(ultrawide.heroHeight).toBe(Math.floor(1440 * WEB_HERO.heightShare));
      for (const f of [hd, qhd, ultrawide]) expect(f.heroHeight).toBeGreaterThanOrEqual(s(660));
    });

    it('zoom 200 % on 1920 × 1080 (960 × 540 CSS) keeps the CSS sizes and lets the hero give way', () => {
      const zoomed = frame(960, 540);
      expect(zoomed.heroHeight).toBe(Math.floor(540 * WEB_HERO.heightShare));
      expect(zoomed.backdropWidth).toBe(s(SHELL.hero.backdropWidth));
    });
  });
});
