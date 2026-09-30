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
