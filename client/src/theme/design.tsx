import { createContext, use, useMemo, type ReactNode } from 'react';
import { Platform, useWindowDimensions, type TextStyle } from 'react-native';

import { detectFormFactor, hasFinePointer, tvScale } from './form-factor';
import {
  colors,
  focusTokens,
  layouts,
  radius,
  space,
  typeRamp,
  type FocusTokens,
  type FormFactor,
  type Layout,
  type RadiusKey,
  type SpaceKey,
  type TypeVariant,
} from './tokens';

export type Design = {
  formFactor: FormFactor;
  isTV: boolean;
  /** TV: window width / 960 (Android TV = 1, tvOS = 2); 1 elsewhere. */
  scale: number;
  window: { width: number; height: number };
  /** Scales an authored dp value for the current form factor. */
  px: (value: number) => number;
  space: Record<SpaceKey, number>;
  radius: Record<RadiusKey, number>;
  type: Record<TypeVariant, TextStyle & { fontSize: number; lineHeight: number }>;
  layout: Layout;
  focus: FocusTokens;
  /** boxShadow strings: raised (cards on hover), overlay (dialogs, sheets, toasts), glow (focus). */
  shadow: { raised: string; overlay: string; glow: string };
};

function mapValues<K extends string, V, R>(record: Record<K, V>, fn: (value: V) => R) {
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, fn(v as V)])) as Record<
    K,
    R
  >;
}

export function createDesign(formFactor: FormFactor, width: number, height: number): Design {
  const isTV = formFactor === 'tv';
  const scale = isTV ? tvScale(width) : 1;
  const px = (value: number) => Math.round(value * scale * 2) / 2;
  const layout = layouts[formFactor];
  const scaledLayout: Layout = {
    ...mapValues(layout, (v) => (typeof v === 'number' ? px(v) : v)),
    controlHeight: mapValues(layout.controlHeight, px),
    iconSize: mapValues(layout.iconSize, px),
  } as Layout;
  const focus = focusTokens[formFactor];
  return {
    formFactor,
    isTV,
    scale,
    window: { width, height },
    px,
    space: mapValues(space, px),
    radius: mapValues(radius, (v) => (v >= 9999 ? v : px(v))),
    type: mapValues(typeRamp[formFactor], (step) => ({
      ...step,
      fontSize: px(step.fontSize),
      lineHeight: px(step.lineHeight),
      letterSpacing: step.letterSpacing ? step.letterSpacing * scale : 0,
    })),
    layout: scaledLayout,
    focus: { ...focus, ringWidth: px(focus.ringWidth), ringOffset: px(focus.ringOffset) },
    shadow: {
      raised: `0 ${px(4)}px ${px(12)}px ${colors.shadow}`,
      overlay: `0 ${px(16)}px ${px(48)}px ${colors.shadow}`,
      glow: `0 0 ${px(18)}px ${colors.focus.glow}`,
    },
  };
}

const DesignContext = createContext<Design | null>(null);

export function DesignProvider({ children }: { children: ReactNode }) {
  const { width, height } = useWindowDimensions();
  const formFactor = detectFormFactor({
    os: Platform.OS,
    isTV: Platform.isTV === true,
    isPad: Platform.OS === 'ios' && Platform.isPad === true,
    width,
    height,
    finePointer: hasFinePointer(),
  });
  const design = useMemo(
    () => createDesign(formFactor, width, height),
    [formFactor, width, height]
  );
  return <DesignContext value={design}>{children}</DesignContext>;
}

export function useDesign(): Design {
  const design = use(DesignContext);
  if (!design) throw new Error('useDesign must be used inside <DesignProvider>');
  return design;
}
