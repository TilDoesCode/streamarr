import { useMemo } from 'react';
import { Platform, type TextStyle } from 'react-native';

import { fonts, useDesign } from '@/theme';

import {
  isLargeShell,
  SHELL,
  shellFont,
  shellHeroFrame,
  shellScale,
  type ShellHeroFrame,
} from './shell-metrics';

const WEB = Platform.OS === 'web';

/** The browser's default font size relative to 16 px (Settings → font size); 1 outside the web. */
export function webTextScale(): number {
  if (!WEB || typeof document === 'undefined' || typeof getComputedStyle !== 'function') return 1;
  const size = parseFloat(getComputedStyle(document.documentElement).fontSize);
  return size > 0 ? size / 16 : 1;
}

export type Shell = {
  /** TV, web desktop and tablet share the large layout; phones use the compact one. */
  large: boolean;
  scale: number;
  /** Scales a 1920 × 1080 mockup value (TV: to the screen; web: fixed CSS px; native tablet: to the width). */
  s: (value: number) => number;
  /** Scaled text size that never drops below `min` px on web/tablet. */
  font: (value: number, min: number) => number;
  /** Page heading of the large shell (Search, Settings); undefined on phones. */
  pageTitle?: TextStyle;
  /** Home hero height, rows top and artwork width. */
  heroFrame: ShellHeroFrame;
};

export function useShell(): Shell {
  const design = useDesign();
  const { formFactor } = design;
  const { width, height } = design.window;
  return useMemo(() => {
    const scale = shellScale(formFactor, width, { web: WEB, textScale: webTextScale() });
    const s = (value: number) => Math.round(value * scale * 2) / 2;
    const large = isLargeShell(formFactor);
    const size = SHELL.type.pageTitle;
    return {
      large,
      scale,
      s,
      font: (value: number, min: number) => shellFont(formFactor, scale, value, min),
      heroFrame: shellHeroFrame(formFactor, s, { width, height }, WEB),
      pageTitle: large
        ? {
            fontFamily: fonts.displayBold,
            fontSize: s(size),
            lineHeight: s(size * 1.1),
            letterSpacing: -s(1.2),
          }
        : undefined,
    };
  }, [formFactor, width, height]);
}
