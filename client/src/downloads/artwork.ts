import type { DownloadEngine } from '@/downloads/engine';

/** Copies small remote images next to a download (the big file goes through the engine). */
export type ArtworkFetcher = {
  /** Resolves true once `relativePath` holds the image; false on any failure (artwork is optional). */
  fetch(url: string, relativePath: string, volumeId: string): Promise<boolean>;
};

const EXTENSION = /\.(jpe?g|png|webp)(?:$|\?)/i;

export function artworkExtension(url: string): string {
  return (EXTENSION.exec(url)?.[1] ?? 'jpg').toLowerCase().replace('jpeg', 'jpg');
}

/** expo-file-system download into the engine's volume (loaded lazily: native only). */
export function createArtworkFetcher(engine: DownloadEngine): ArtworkFetcher {
  return {
    async fetch(url, relativePath, volumeId) {
      try {
        const { Directory, File } = await import('expo-file-system');
        const target = engine.uriFor(relativePath, volumeId);
        new Directory(target.slice(0, target.lastIndexOf('/'))).create({
          intermediates: true,
          idempotent: true,
        });
        await File.downloadFileAsync(url, new File(target), { idempotent: true });
        return true;
      } catch {
        return false;
      }
    },
  };
}
