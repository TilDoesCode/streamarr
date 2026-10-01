import { validHex } from '@/lib/color';
import { colors } from '@/theme';

export type AmbientInput = {
  image?: string | null;
  tint?: string | null;
  tint2?: string | null;
  /** Brightest art colour (`highlight`), sizes the TV glass over this title. */
  highlight?: string | null;
};

export type AmbientScene = {
  key: string;
  image: string | null;
  tint: string;
  tint2: string;
  /** True when the server has not sent a tint yet (neutral Aurora wash). */
  neutral: boolean;
};

const TMDB_SIZE = /(\/t\/p\/)(w\d+|original)(\/)/;

/** Ambient artwork is blurred anyway: ask TMDB for a small rendition. */
export function smallArtwork(url: string | null | undefined, size = 'w300'): string | null {
  if (!url) return null;
  return url.replace(TMDB_SIZE, `$1${size}$3`);
}

/** Normalizes a focused title into what the backdrop paints; missing tints fall back to the Aurora wash. */
export function ambientScene(input: AmbientInput | null | undefined): AmbientScene {
  const image = smallArtwork(input?.image);
  const tint = validHex(input?.tint);
  const tint2 = validHex(input?.tint2);
  const neutral = !tint;
  const scene = {
    image,
    tint: tint ?? colors.aurora.wash,
    tint2: tint2 ?? (tint ? colors.aurora.tint2 : colors.aurora.wash2),
    neutral,
  };
  return { ...scene, key: `${scene.image ?? ''}|${scene.tint}|${scene.tint2}` };
}
