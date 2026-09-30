export type GlassMode = 'liquid' | 'blur' | 'css' | 'translucent' | 'solid';

export type GlassEnvironment = {
  os: string;
  isTV: boolean;
  /** iOS 26+: `isLiquidGlassAvailable() && isGlassEffectAPIAvailable()`. */
  liquidGlass: boolean;
  reduceTransparency: boolean;
};

/** PLAN §5 Glass rule: which rendering a Glass surface uses on this device. */
export function selectGlassMode({
  os,
  isTV,
  liquidGlass,
  reduceTransparency,
}: GlassEnvironment): GlassMode {
  if (reduceTransparency) return 'solid';
  if (os === 'ios') return liquidGlass ? 'liquid' : 'blur';
  if (os === 'web') return 'css';
  if (os === 'android') return isTV ? 'solid' : 'translucent';
  return 'solid';
}
