/**
 * The last frame as a poster: `<video>` turns black the moment its source changes, while expo-video keeps the old
 * picture until the new one renders (E18). Only a CORS-clean picture (MSE, hls.js) can be read; else none.
 */
export function lastFrame(video: HTMLVideoElement): string | undefined {
  if (typeof document === 'undefined' || video.readyState < 2 || !video.videoWidth)
    return undefined;
  try {
    const canvas = document.createElement('canvas');
    // Half size is enough for a picture that shows for a few seconds under the switching card.
    canvas.width = Math.round(video.videoWidth / 2);
    canvas.height = Math.round(video.videoHeight / 2);
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch {
    // A tainted (cross-origin) picture cannot be read.
    return undefined;
  }
}
