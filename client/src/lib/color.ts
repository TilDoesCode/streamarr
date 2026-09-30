const HEX = /^#?([0-9a-f]{6})$/i;

/** `#RRGGBB` → `rgba(r, g, b, alpha)`; anything else is returned unchanged. */
export function withAlpha(color: string, alpha: number): string {
  const match = HEX.exec(color.trim());
  if (!match) return color;
  const value = parseInt(match[1] ?? '0', 16);
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 1000) / 1000;
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${a})`;
}

/** A usable `#RRGGBB` or null (server tints may be missing or malformed). */
export function validHex(color: string | null | undefined): string | null {
  if (!color) return null;
  const match = HEX.exec(color.trim());
  return match ? `#${(match[1] ?? '').toUpperCase()}` : null;
}

export type Rgb = readonly [number, number, number];

/** `#RRGGBB` or `rgba(r, g, b, a)` → channels and alpha (null when unparsable). */
export function parseColor(color: string): { rgb: Rgb; alpha: number } | null {
  const hex = HEX.exec(color.trim());
  if (hex) {
    const v = parseInt(hex[1] ?? '0', 16);
    return { rgb: [(v >> 16) & 255, (v >> 8) & 255, v & 255], alpha: 1 };
  }
  const rgba = /^rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\s*\)$/.exec(
    color.trim()
  );
  if (!rgba) return null;
  return {
    rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])],
    alpha: rgba[4] === undefined ? 1 : Number(rgba[4]),
  };
}

/** Paints `color` (with its alpha, times `opacity`) over an opaque background. */
export function composite(background: Rgb, color: string, opacity = 1): Rgb {
  const parsed = parseColor(color);
  if (!parsed) return background;
  const a = parsed.alpha * opacity;
  return background.map((v, i) => (parsed.rgb[i] ?? 0) * a + v * (1 - a)) as unknown as Rgb;
}

/** `a` weight of `a` mixed into `b` as `#RRGGBB`. */
export function mixHex(a: string, b: string, weight: number): string {
  const x = parseColor(a)?.rgb ?? [0, 0, 0];
  const y = parseColor(b)?.rgb ?? [0, 0, 0];
  const hex = x
    .map((v, i) => Math.round(v * weight + (y[i] ?? 0) * (1 - weight)))
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
  return `#${hex.toUpperCase()}`;
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two opaque colours. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
