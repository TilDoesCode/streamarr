import { useMemo, type ReactNode } from 'react';

import { createDesign, DesignScope, useDesign } from '@/theme';

import { SHELL } from './shell-metrics';
import { useShell } from './use-shell';

/** Web desktop/tablet inside the large shell: the TV type ramp, spacing and controls at the shell scale. */
export function ShellDesign({ children }: { children: ReactNode }) {
  const design = useDesign();
  const { large, scale } = useShell();
  const value = useMemo(() => {
    if (!large || design.isTV) return design;
    const tv = createDesign('tv', SHELL.width * scale, 0);
    return {
      ...tv,
      formFactor: design.formFactor,
      isTV: false,
      window: design.window,
      focus: design.focus,
      layout: { ...tv.layout, gutter: design.layout.gutter },
    };
  }, [design, large, scale]);
  return <DesignScope value={value}>{children}</DesignScope>;
}
