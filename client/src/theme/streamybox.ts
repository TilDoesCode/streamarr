import type palette from './colors.json';
import streamyboxPalette from './colors-streamybox.json';

/** Token overrides of the Streamybox theme (streamybox design/TvDesign.kt + Motion.kt, dark). */

type Palette = typeof palette;
type Overrides<T> = { [K in keyof T]?: T[K] extends string ? string : Overrides<T[K]> };

// Palette overrides live in JSON like colors.json (raw colours stay out of TS).
export const STREAMYBOX_COLORS = streamyboxPalette satisfies Overrides<Palette>;

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
