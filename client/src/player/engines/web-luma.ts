/** Brightest pixel of a tiny downscaled frame; undefined where the picture cannot be read (tainted, no canvas). */
export type LumaSampler = (video: HTMLVideoElement) => number | undefined;

const LUMA_WIDTH = 16;
const LUMA_HEIGHT = 9;

export function createLumaSampler(): LumaSampler {
  let canvas: HTMLCanvasElement | null = null;
  let blocked = false;
  return (video) => {
    if (blocked || typeof document === 'undefined' || video.readyState < 2) return undefined;
    try {
      canvas ??= document.createElement('canvas');
      canvas.width = LUMA_WIDTH;
      canvas.height = LUMA_HEIGHT;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return void (blocked = true);
      context.drawImage(video, 0, 0, LUMA_WIDTH, LUMA_HEIGHT);
      const { data } = context.getImageData(0, 0, LUMA_WIDTH, LUMA_HEIGHT);
      let max = 0;
      for (let i = 0; i < data.length; i += 4)
        max = Math.max(max, 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!);
      return Math.round(max);
    } catch {
      // A cross-origin picture taints the canvas (SecurityError): never try again for this engine.
      blocked = true;
      return undefined;
    }
  };
}
