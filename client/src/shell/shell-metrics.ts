import { STREAMYBOX_SHELL } from '@/theme/streamybox';
import { themed, type FormFactor } from '@/theme/tokens';

/** The one large-screen layout (TV, web desktop, tablet), authored in 1920 × 1080 logical points. */
export const SHELL = themed(
  {
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
    card: { radius: 20 },
  } as const,
  STREAMYBOX_SHELL
);

/** Native tablets below this scale would make the 10-foot layout unreadable; they scroll/crop instead. */
export const MIN_WEB_SCALE = 0.6;

/** Web (desktop and tablet browsers): one fixed scale, so CSS px stay constant and browser zoom really zooms. */
export const WEB_SHELL_SCALE = 0.72;

/** Web home hero: the backdrop keeps this share of the window width, the hero at most this share of its height. */
export const WEB_HERO = { widthShare: 1500 / 1920, aspect: 0.36, heightShare: 0.55 } as const;

export function isLargeShell(formFactor: FormFactor): boolean {
  return formFactor !== 'phone';
}

/** Smallest readable text on scaled-down native tablets (TV scales exactly: its dp are half the pixels). */
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

export type ShellPlatform = {
  web: boolean;
  /** Web: the browser's default font size / 16 (the user's text-size preference). */
  textScale?: number;
};

/** Logical point → dp/CSS px: TV maps 1920 onto the window width exactly; native tablets keep a floor; web is fixed. */
export function shellScale(
  formFactor: FormFactor,
  width: number,
  platform: ShellPlatform = { web: false }
): number {
  if (formFactor === 'tv') return width / SHELL.width;
  if (platform.web) return WEB_SHELL_SCALE * clampTextScale(platform.textScale);
  return Math.max(MIN_WEB_SCALE, width / SHELL.width);
}

function clampTextScale(value: number | undefined): number {
  return value && Number.isFinite(value) ? Math.min(2, Math.max(0.75, value)) : 1;
}

export type ShellHeroFrame = {
  heroHeight: number;
  rowsTop: number;
  /** Width of the hero artwork at the right edge. */
  backdropWidth: number;
  /** Web: the copy sits at the hero's bottom (tall heroes on large windows); TV/native keep the mockup's top. */
  copyAnchor: 'top' | 'bottom';
};

/** Home hero: TV the mockup; native tablets capped to the 1080p height share; web artwork follows the window width. */
export function shellHeroFrame(
  formFactor: FormFactor,
  s: (value: number) => number,
  window: { width: number; height: number },
  web = false
): ShellHeroFrame {
  const heroHeight = s(SHELL.hero.height);
  const rowsTop = s(SHELL.row.top);
  const backdropWidth = s(SHELL.hero.backdropWidth);
  if (formFactor === 'tv') return { heroHeight, rowsTop, backdropWidth, copyAnchor: 'top' };
  if (web) {
    const wide = Math.max(backdropWidth, Math.round(window.width * WEB_HERO.widthShare));
    const height = Math.min(
      Math.floor(window.height * WEB_HERO.heightShare),
      Math.max(heroHeight, Math.round(wide * WEB_HERO.aspect))
    );
    return {
      heroHeight: height,
      rowsTop: height - (heroHeight - rowsTop),
      backdropWidth: wide,
      copyAnchor: 'bottom',
    };
  }
  const fit = (value: number) => Math.floor((value * window.height) / SHELL.height);
  return {
    heroHeight: Math.min(heroHeight, fit(SHELL.hero.height)),
    rowsTop: Math.min(rowsTop, fit(SHELL.row.top)),
    backdropWidth,
    copyAnchor: 'top',
  };
}
