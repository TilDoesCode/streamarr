const POSTER_WIDTH = 640;

/** The last frame as a poster under the switching card (E18); none when the picture cannot be read. */
export function lastFrame(video: HTMLVideoElement): string | undefined {
  if (typeof document === 'undefined' || video.readyState < 2 || !video.videoWidth)
    return undefined;
  try {
    const canvas = document.createElement('canvas');
    // A small picture is enough for a few seconds under the card and keeps the encode cheap (review R5).
    const scale = Math.min(1, POSTER_WIDTH / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch {
    // A tainted (cross-origin) picture cannot be read.
    return undefined;
  }
}
