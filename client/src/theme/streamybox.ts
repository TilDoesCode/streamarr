import type palette from './colors.json';

/** Token overrides of the Streamybox theme (streamybox design/TvDesign.kt + Motion.kt, dark). */

type Palette = typeof palette;
type Overrides<T> = { [K in keyof T]?: T[K] extends string ? string : Overrides<T[K]> };

export const STREAMYBOX_COLORS = {
  background: '#07090E',
  surface: { DEFAULT: '#10141C', raised: '#1A2030', overlay: '#1D2432' },
  foreground: {
    DEFAULT: '#F2F4F8',
    muted: 'rgba(196, 205, 219, 0.72)',
    mutedTv: 'rgba(222, 228, 238, 0.86)',
    subtleTv: 'rgba(170, 181, 199, 0.86)',
    subtle: 'rgba(141, 151, 168, 0.8)',
    disabled: 'rgba(141, 151, 168, 0.42)',
  },
  primary: { DEFAULT: '#F2F4F8', foreground: '#07090E' },
  secondary: {
    DEFAULT: 'rgba(30, 37, 50, 0.84)',
    hover: 'rgba(51, 60, 78, 0.92)',
    foreground: '#F2F4F8',
  },
  accent: {
    DEFAULT: '#8CC4FF',
    muted: 'rgba(140, 196, 255, 0.16)',
    hover: 'rgba(140, 196, 255, 0.26)',
    foreground: '#07111F',
  },
  aurora: { tint: '#8CC4FF', tint2: '#121826', wash: '#0E131C', wash2: '#07090E' },
  glass: {
    DEFAULT: 'rgba(255, 255, 255, 0.07)',
    subtle: 'rgba(255, 255, 255, 0.05)',
    strong: 'rgba(255, 255, 255, 0.11)',
    highlight: 'rgba(255, 255, 255, 0.12)',
    border: 'rgba(255, 255, 255, 0.08)',
    solid: '#11161F',
    tinted: 'rgba(16, 20, 28, 0.84)',
  },
  info: { DEFAULT: '#8CC4FF', muted: 'rgba(140, 196, 255, 0.16)' },
  muted: 'rgba(255, 255, 255, 0.05)',
  border: 'rgba(255, 255, 255, 0.08)',
  input: 'rgba(255, 255, 255, 0.07)',
  focus: { DEFAULT: '#F2F4F8', glow: 'rgba(156, 196, 255, 0.38)' },
  scrim: {
    DEFAULT: 'rgba(7, 9, 14, 0.72)',
    strong: 'rgba(7, 9, 14, 0.96)',
    clear: 'rgba(7, 9, 14, 0)',
  },
  brand: { from: '#F2F4F8', mid: '#D6E6FA', to: '#8CC4FF' },
} satisfies Overrides<Palette>;

/** Inter (bundled static instances of Streamybox's variable font: opsz 16 text, opsz 32 display). */
export const STREAMYBOX_FONTS = {
  displayBold: 'Inter-DisplayBold',
  display: 'Inter-SemiBold',
  body: 'Inter-Regular',
  bodyMedium: 'Inter-Medium',
  bodySemiBold: 'Inter-SemiBold',
  bodyBold: 'Inter-SemiBold',
  mono: 'Inter-Medium',
};

/** TV ramp in dp ([size, lineHeight, letterSpacing]): Streamybox's calmer 38/28/20/16/14/12/11 scale. */
export const STREAMYBOX_TV_TYPE = {
  display: [38, 42, -0.57],
  title: [28, 33, -0.42],
  heading: [18, 23, -0.1],
  subheading: [16, 21, 0],
  body: [14, 20, 0],
  callout: [13, 18, 0],
  caption: [12, 16, 0],
  overline: [11, 14, 1.5],
  label: [14, 18, 0],
  spec: [10, 13, 0.3],
} as const;

export const STREAMYBOX_RADIUS = { sm: 8, md: 14, xl: 26 };

/** Calm lift: card 1.04 like TvDesign.cardStyle, a slim ring on the edge, the same clearance air. */
export const STREAMYBOX_TV_FOCUS = {
  cardScale: 1.04,
  buttonScale: 1.04,
  pressedScale: 0.96,
  ringWidth: 2,
  ringOffset: 1,
};

export const STREAMYBOX_MOTION = { press: 100, focus: 170, enter: 240, exit: 150, panelRise: 20 };

// Critically damped (no bounce), settles in ~170 ms like Motion.FOCUS.
export const STREAMYBOX_SPRINGS = {
  focus: { damping: 54, stiffness: 680, overshootClamping: true },
  press: { damping: 40, stiffness: 400, overshootClamping: true },
};

export const STREAMYBOX_EASING = { out: [0.05, 0.7, 0.1, 1], sheet: [0.2, 0, 0, 1] } as const;

/** Copy of `base` with `overrides` applied (nested objects merged, leaves replaced). */
export function mergeTokens<T extends object>(base: T, overrides: object): T {
  const out = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    const current = out[key];
    out[key] =
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current &&
      typeof current === 'object'
        ? mergeTokens(current, value)
        : value;
  }
  return out as T;
}
