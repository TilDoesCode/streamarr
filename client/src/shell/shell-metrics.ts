import type { FormFactor } from '@/theme/tokens';

/** The one large-screen layout (TV, web desktop, tablet), authored in 1920 × 1080 logical points. */
export const SHELL = {
  width: 1920,
  height: 1080,
  rail: { width: 104, inset: 20, top: 24, pill: 84, mark: 52, item: 60, avatar: 52, gap: 12 },
  hero: { height: 660, backdropWidth: 1500, copyLeft: 168, copyWidth: 760, copyTop: 96 },
  row: {
    top: 648,
    focusTop: 120,
    left: 168,
    right: 64,
    header: 44,
    headerGap: 16,
    gap: 24,
    // TV between cards: room for the focus lift + ring + air (theme/focus-clearance).
    tvCardGap: 40,
    arrow: 44,
  },
  // Apple TV: bottom edge of the native top tab bar (sheets and the Bühne info column stay below it).
  tvosTabBarBottom: 136,
  landscape: { width: 352, height: 198 },
  poster: { width: 208, height: 312 },
  type: {
    eyebrow: 18,
    heroTitle: 72,
    meta: 22,
    overview: 24,
    rowTitle: 32,
    cardTitle: 22,
    cardSubline: 18,
    spec: 15,
    button: 22,
    pageTitle: 56,
  },
  page: { top: 96 },
  button: 64,
  // tvOS: the native top tab bar's inset leaves no room for the full logo box above the first row.
  logo: { width: 520, height: 190, tvosHeight: 140 },
} as const;

/** Web below this scale would make the 10-foot layout unreadable; it scrolls/crops instead. */
export const MIN_WEB_SCALE = 0.6;

export function isLargeShell(formFactor: FormFactor): boolean {
  return formFactor !== 'phone';
}

/** Logical point → dp/CSS px: TV maps 1920 onto the window width exactly; web/tablet keep a floor. */
/** Smallest readable text on scaled-down web/tablet windows (TV scales exactly: its dp are half the pixels). */
export const MIN_TEXT = { spec: 11, caption: 15, subline: 13 } as const;

export function shellFont(
  formFactor: FormFactor,
  scale: number,
  value: number,
  min: number
): number {
  const size = Math.round(value * scale * 2) / 2;
  return formFactor === 'tv' ? size : Math.max(size, min);
}

export function shellScale(formFactor: FormFactor, width: number): number {
  const fit = width / SHELL.width;
  return formFactor === 'tv' ? fit : Math.max(MIN_WEB_SCALE, fit);
}

export type ShellHeroFrame = { heroHeight: number; rowsTop: number };

/** Home hero height and rows top; windows wider than 16:9 (web, tablet) keep the 1080p share of the height. */
export function shellHeroFrame(
  formFactor: FormFactor,
  s: (value: number) => number,
  windowHeight: number
): ShellHeroFrame {
  const heroHeight = s(SHELL.hero.height);
  const rowsTop = s(SHELL.row.top);
  if (formFactor === 'tv') return { heroHeight, rowsTop };
  const fit = (value: number) => Math.floor((value * windowHeight) / SHELL.height);
  return {
    heroHeight: Math.min(heroHeight, fit(SHELL.hero.height)),
    rowsTop: Math.min(rowsTop, fit(SHELL.row.top)),
  };
}
