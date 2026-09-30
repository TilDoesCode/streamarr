import { useMemo } from 'react';
import type { TextStyle } from 'react-native';

import { fonts, useDesign } from '@/theme';

import { isLargeShell, SHELL, shellScale } from './shell-metrics';

export type Shell = {
  /** TV, web desktop and tablet share the large layout; phones use the compact one. */
  large: boolean;
  scale: number;
  /** Scales a 1920 × 1080 mockup value. */
  s: (value: number) => number;
  /** Page heading of the large shell (Search, Settings); undefined on phones. */
  pageTitle?: TextStyle;
};

export function useShell(): Shell {
  const design = useDesign();
  const { formFactor } = design;
  const { width } = design.window;
  return useMemo(() => {
    const scale = shellScale(formFactor, width);
    const s = (value: number) => Math.round(value * scale * 2) / 2;
    const large = isLargeShell(formFactor);
    const size = SHELL.type.pageTitle;
    return {
      large,
      scale,
      s,
      pageTitle: large
        ? {
            fontFamily: fonts.displayBold,
            fontSize: s(size),
            lineHeight: s(size * 1.1),
            letterSpacing: -s(1.2),
          }
        : undefined,
    };
  }, [formFactor, width]);
}
