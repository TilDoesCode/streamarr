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
  | 'label';

type TypeStep = Pick<TextStyle, 'fontSize' | 'lineHeight' | 'fontWeight' | 'letterSpacing'> & {
  fontSize: number;
  lineHeight: number;
};

const handheldType: Record<TypeVariant, TypeStep> = {
  display: { fontSize: 34, lineHeight: 40, fontWeight: '700', letterSpacing: -0.6 },
  title: { fontSize: 26, lineHeight: 32, fontWeight: '700', letterSpacing: -0.4 },
  heading: { fontSize: 20, lineHeight: 26, fontWeight: '600', letterSpacing: -0.2 },
  subheading: { fontSize: 17, lineHeight: 22, fontWeight: '600', letterSpacing: -0.1 },
  body: { fontSize: 15, lineHeight: 22, fontWeight: '400', letterSpacing: 0 },
  callout: { fontSize: 14, lineHeight: 20, fontWeight: '500', letterSpacing: 0 },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '500', letterSpacing: 0 },
  overline: { fontSize: 11, lineHeight: 14, fontWeight: '700', letterSpacing: 0.9 },
  label: { fontSize: 15, lineHeight: 20, fontWeight: '600', letterSpacing: 0 },
};

const largeType: Record<TypeVariant, TypeStep> = {
  display: { fontSize: 44, lineHeight: 50, fontWeight: '700', letterSpacing: -0.9 },
  title: { fontSize: 30, lineHeight: 36, fontWeight: '700', letterSpacing: -0.5 },
  heading: { fontSize: 22, lineHeight: 28, fontWeight: '600', letterSpacing: -0.2 },
  subheading: { fontSize: 18, lineHeight: 24, fontWeight: '600', letterSpacing: -0.1 },
  body: { fontSize: 16, lineHeight: 24, fontWeight: '400', letterSpacing: 0 },
  callout: { fontSize: 15, lineHeight: 21, fontWeight: '500', letterSpacing: 0 },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '500', letterSpacing: 0 },
  overline: { fontSize: 12, lineHeight: 16, fontWeight: '700', letterSpacing: 1 },
  label: { fontSize: 16, lineHeight: 20, fontWeight: '600', letterSpacing: 0 },
};

// 10-foot ramp in Android TV dp (960 × 540 canvas); scaled by the TV scale factor.
const tvType: Record<TypeVariant, TypeStep> = {
  display: { fontSize: 40, lineHeight: 46, fontWeight: '700', letterSpacing: -0.8 },
  title: { fontSize: 28, lineHeight: 34, fontWeight: '700', letterSpacing: -0.4 },
  heading: { fontSize: 19, lineHeight: 25, fontWeight: '600', letterSpacing: -0.1 },
  subheading: { fontSize: 16, lineHeight: 21, fontWeight: '600', letterSpacing: 0 },
  body: { fontSize: 14, lineHeight: 20, fontWeight: '400', letterSpacing: 0 },
  callout: { fontSize: 13, lineHeight: 18, fontWeight: '500', letterSpacing: 0 },
  caption: { fontSize: 11, lineHeight: 15, fontWeight: '500', letterSpacing: 0 },
  overline: { fontSize: 10, lineHeight: 13, fontWeight: '700', letterSpacing: 0.9 },
  label: { fontSize: 14, lineHeight: 18, fontWeight: '600', letterSpacing: 0 },
};

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
    cardScale: 1.08,
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
  /** Focus lift / ring. */
  focus: 160,
  /** Small state changes (toggle, chip). */
  state: 180,
  /** Enter/exit of overlays (toast, dialog). */
  enter: 240,
  exit: 180,
  /** Skeleton shimmer period. */
  pulse: 1400,
  /** Toast visibility. */
  toast: 4000,
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
