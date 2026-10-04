import { PixelRatio } from 'react-native';

import type { components } from '@/api/schema';

export type ArtworkSizes = components['schemas']['ArtworkSizesDto'];
export type ArtworkKind = 'poster' | 'backdrop';
export type ArtworkClass = 'small' | 'medium' | 'large';

// Pixel widths of the server's classes (TMDB buckets: posters w185/w342/w780, backdrops and stills w300/w780/w1280).
export const ARTWORK_WIDTHS: Record<ArtworkKind, Record<ArtworkClass, number>> = {
  poster: { small: 185, medium: 342, large: 780 },
  backdrop: { small: 300, medium: 780, large: 1280 },
};

// A class may be up to this much narrower than the drawn pixels (no visible blur at this upscale).
const UPSCALE = 1.15;
const CLASSES: readonly ArtworkClass[] = ['small', 'medium', 'large'];

/** The smallest class wide enough for the drawn size (css width × density × focus scale). */
export function artworkClass(kind: ArtworkKind, cssWidth: number, dpr: number, scale = 1) {
  const pixels = cssWidth * dpr * scale;
  return CLASSES.find((size) => ARTWORK_WIDTHS[kind][size] * UPSCALE >= pixels) ?? 'large';
}

/** URL for an image drawn `cssWidth` wide; older servers without size classes keep the plain URL. */
export function artworkFor(
  sizes: ArtworkSizes | null | undefined,
  fallback: string | null | undefined,
  { kind, cssWidth, dpr = PixelRatio.get(), scale = 1, size }: ArtworkRequest
): string | null {
  const wanted = size ?? artworkClass(kind, cssWidth ?? 0, dpr, scale);
  return sizes?.[wanted] ?? fallback ?? null;
}

export type ArtworkRequest = {
  kind: ArtworkKind;
  /** Drawn width in css px / points. */
  cssWidth?: number;
  dpr?: number;
  /** Focus lift (TV cards grow ~1.1×). */
  scale?: number;
  /** A fixed class (hero and Bühne backdrops). */
  size?: ArtworkClass;
};
