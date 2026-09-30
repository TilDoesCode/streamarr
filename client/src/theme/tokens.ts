import type { TextStyle } from 'react-native';

import palette from './colors.json';
import radiusTokens from './radius.json';

export type FormFactor = 'phone' | 'tablet' | 'tv' | 'desktop-web';

export const colors = palette;

export const space = {
  none: 0,
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  '2xl': 24,
  '3xl': 32,
  '4xl': 40,
  '5xl': 48,
  '6xl': 64,
} as const;
export type SpaceKey = keyof typeof space;

export const radius = radiusTokens.radius;
export type RadiusKey = keyof typeof radius;

export type TypeVariant =
  | 'display'
  | 'title'
  | 'heading'
  | 'subheading'
  | 'body'
  | 'callout'
  | 'caption'
  | 'overline'
  | 'label'
  | 'spec';

/** Font family names = PostScript names, so embedded (Android/iOS) and web-loaded faces match. */
export const fonts = {
  displayBold: 'Outfit-Bold',
  display: 'Outfit-SemiBold',
  body: 'Figtree-Regular',
  bodyMedium: 'Figtree-Medium',
  bodySemiBold: 'Figtree-SemiBold',
  bodyBold: 'Figtree-Bold',
  mono: 'JetBrainsMono-Medium',
} as const;
export type FontKey = keyof typeof fonts;

type TypeStep = Pick<TextStyle, 'letterSpacing'> & {
  fontSize: number;
  lineHeight: number;
  fontFamily: string;
};

const FAMILY: Record<TypeVariant, string> = {
  display: fonts.displayBold,
  title: fonts.displayBold,
  heading: fonts.display,
  subheading: fonts.bodySemiBold,
  body: fonts.body,
  callout: fonts.bodyMedium,
  caption: fonts.bodyMedium,
  overline: fonts.bodyBold,
  label: fonts.bodySemiBold,
  spec: fonts.mono,
};

type Step = [fontSize: number, lineHeight: number, letterSpacing: number];

function ramp(steps: Record<TypeVariant, Step>): Record<TypeVariant, TypeStep> {
  return Object.fromEntries(
    Object.entries(steps).map(([variant, value]) => {
      const [fontSize, lineHeight, letterSpacing] = value as Step;
      const fontFamily = FAMILY[variant as TypeVariant];
      return [variant, { fontSize, lineHeight, letterSpacing, fontFamily }];
    })
  ) as Record<TypeVariant, TypeStep>;
}

// Aurora: Outfit display with tight tracking, Figtree text, JetBrains Mono caps for spec labels.
const handheldType = ramp({
  display: [34, 38, -0.85],
  title: [26, 31, -0.5],
  heading: [20, 26, -0.2],
  subheading: [17, 22, 0],
  body: [17, 25, 0],
  callout: [15, 21, 0],
  caption: [12, 16, 0],
  overline: [11, 14, 1.1],
  label: [16, 20, 0],
  spec: [11, 14, 0.5],
});

const largeType = ramp({
  display: [48, 50, -1.2],
  title: [32, 38, -0.6],
  heading: [24, 30, -0.3],
  subheading: [19, 24, 0],
  body: [17, 26, 0],
  callout: [15, 21, 0],
  caption: [13, 18, 0],
  overline: [12, 16, 1.2],
  label: [16, 20, 0],
  spec: [12, 16, 0.5],
});

// 10-foot ramp in Android TV dp (960 × 540 canvas); scaled by the TV scale factor.
const tvType = ramp({
  display: [44, 46, -1.1],
  title: [28, 33, -0.5],
  heading: [19, 25, -0.2],
  subheading: [16, 21, 0],
  body: [14, 20, 0],
  callout: [13, 18, 0],
  caption: [11, 15, 0],
  overline: [10, 13, 1],
  label: [14, 18, 0],
  spec: [9.5, 12, 0.4],
});

export const typeRamp: Record<FormFactor, Record<TypeVariant, TypeStep>> = {
  phone: handheldType,
  tablet: largeType,
  'desktop-web': largeType,
  tv: tvType,
};

export type Layout = {
  /** Horizontal screen edge padding (TV: overscan-safe). */
  gutter: number;
  /** Top/bottom screen padding (TV: overscan-safe). */
  edgeVertical: number;
  sectionGap: number;
  cardGap: number;
  posterWidth: number;
  landscapeWidth: number;
  episodeThumbWidth: number;
  heroHeight: number;
  controlHeight: { sm: number; md: number; lg: number };
  iconSize: { sm: number; md: number; lg: number };
  maxContentWidth: number;
};

export const layouts: Record<FormFactor, Layout> = {
  phone: {
    gutter: 16,
    edgeVertical: 16,
    sectionGap: 32,
    cardGap: 12,
    posterWidth: 112,
    landscapeWidth: 232,
    episodeThumbWidth: 136,
    heroHeight: 460,
    controlHeight: { sm: 36, md: 44, lg: 52 },
    iconSize: { sm: 16, md: 20, lg: 22 },
    maxContentWidth: 640,
  },
  tablet: {
    gutter: 24,
    edgeVertical: 24,
    sectionGap: 40,
    cardGap: 16,
    posterWidth: 144,
    landscapeWidth: 288,
    episodeThumbWidth: 184,
    heroHeight: 520,
    controlHeight: { sm: 36, md: 44, lg: 52 },
    iconSize: { sm: 16, md: 20, lg: 22 },
    maxContentWidth: 1100,
  },
  'desktop-web': {
    gutter: 48,
    edgeVertical: 32,
    sectionGap: 44,
    cardGap: 16,
    posterWidth: 164,
    landscapeWidth: 312,
    episodeThumbWidth: 208,
    heroHeight: 560,
    controlHeight: { sm: 34, md: 42, lg: 50 },
    iconSize: { sm: 16, md: 18, lg: 20 },
    maxContentWidth: 1400,
  },
  tv: {
    gutter: 48,
    edgeVertical: 27,
    sectionGap: 24,
    cardGap: 14,
    posterWidth: 104,
    landscapeWidth: 196,
    episodeThumbWidth: 168,
    heroHeight: 360,
    controlHeight: { sm: 30, md: 36, lg: 40 },
    iconSize: { sm: 14, md: 16, lg: 18 },
    maxContentWidth: 960,
  },
};

export type FocusTokens = {
  /** Scale of a focused card / button. 1 disables the lift. */
  cardScale: number;
  buttonScale: number;
  pressedScale: number;
  ringWidth: number;
  ringOffset: number;
};

export const focusTokens: Record<FormFactor, FocusTokens> = {
  tv: {
    cardScale: 1.1,
    buttonScale: 1.06,
    pressedScale: 0.97,
    ringWidth: 3,
    ringOffset: 3,
  },
  'desktop-web': {
    cardScale: 1.04,
    buttonScale: 1.02,
    pressedScale: 0.97,
    ringWidth: 2,
    ringOffset: 3,
  },
  tablet: {
    cardScale: 1.04,
    buttonScale: 1.02,
    pressedScale: 0.97,
    ringWidth: 2,
    ringOffset: 3,
  },
  phone: {
    cardScale: 1,
    buttonScale: 1,
    pressedScale: 0.97,
    ringWidth: 2,
    ringOffset: 2,
  },
};

export const motion = {
  /** Press feedback. */
  press: 120,
  /** Focus ring fade (the lift itself uses `springs.focus`). */
  focus: 160,
  /** Small state changes (toggle, chip). */
  state: 180,
  /** Enter/exit of overlays (toast, dialog, glass panels). */
  enter: 280,
  exit: 180,
  /** Glass panels rise this far while fading in. */
  panelRise: 24,
  /** Ambient backdrop + tint crossfade and its debounce. */
  ambient: 700,
  ambientDebounce: 150,
  /** Skeleton shimmer period. */
  pulse: 1400,
  /** Toast visibility. */
  toast: 4000,
} as const;

/** Reanimated spring configs. */
export const springs = {
  focus: { damping: 18, stiffness: 180, mass: 1 },
  press: { damping: 22, stiffness: 320, mass: 1 },
} as const;

/** cubic-bezier control points; build Reanimated easings from these. */
export const easing = {
  out: [0.23, 1, 0.32, 1],
  sheet: [0.32, 0.72, 0, 1],
} as const;

export const aspect = {
  poster: 2 / 3,
  landscape: 16 / 9,
} as const;
