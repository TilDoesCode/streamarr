import type { FocusTokens } from './tokens';

type Ring = Pick<FocusTokens, 'ringOffset' | 'ringWidth' | 'air'>;

/** Minimum gap next to an item of `extent` lifted by `scale`: growth per side + the scaled ring + air. */
export function focusClearance(focus: Ring, extent: number, scale: number): number {
  const ring = focus.ringOffset + focus.ringWidth;
  return Math.ceil((extent * (scale - 1)) / 2 + ring * scale + focus.air);
}

/** Largest lift (at most `maxScale`) that keeps an item of `extent` clear of a neighbour `gap` away. */
export function clearScale(focus: Ring, extent: number, gap: number, maxScale: number): number {
  const half = extent / 2;
  const ring = focus.ringOffset + focus.ringWidth;
  return Math.max(1, Math.min(maxScale, (gap - focus.air + half) / (half + ring)));
}

export type FocusSpacing = {
  /** Largest growth per side of a focused button (wider buttons lift less). */
  buttonGrowth: number;
  /** Minimum gap between focusable buttons side by side. */
  rowGap: number;
  /** Minimum gap between stacked focusable buttons. */
  stackGap: number;
  /** Minimum gap between items that only draw the ring (no lift): list rows, panel cards. */
  ringGap: number;
};

export function focusSpacing(focus: FocusTokens, controlHeight: number): FocusSpacing {
  return {
    buttonGrowth: (focus.buttonExtent * (focus.buttonScale - 1)) / 2,
    rowGap: focusClearance(focus, focus.buttonExtent, focus.buttonScale),
    stackGap: focusClearance(focus, controlHeight, focus.buttonScale),
    ringGap: focusClearance(focus, 0, 1),
  };
}

/** A row/stack gap raised to the focus clearance where needed (never lowered). */
export function focusGap(
  focus: FocusSpacing,
  gap: number,
  axis: 'row' | 'stack' | 'ring' = 'row'
): number {
  return Math.max(gap, focus[`${axis}Gap`]);
}
