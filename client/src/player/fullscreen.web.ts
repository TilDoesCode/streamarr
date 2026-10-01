type AppleVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
  webkitDisplayingFullscreen?: boolean;
};

const elementFullscreen =
  typeof document !== 'undefined' && !!document.documentElement.requestFullscreen;

/** iPhone Safari has no element full screen; only the video itself can go full screen (AVKit). */
const videoFullscreen =
  !elementFullscreen &&
  typeof HTMLVideoElement !== 'undefined' &&
  typeof (HTMLVideoElement.prototype as AppleVideo).webkitEnterFullscreen === 'function';

export const fullscreenAvailable = elementFullscreen || videoFullscreen;

function playerVideo(): AppleVideo | null {
  return typeof document === 'undefined' ? null : document.querySelector('video');
}

export function isFullscreen(): boolean {
  if (typeof document === 'undefined') return false;
  if (videoFullscreen) return !!playerVideo()?.webkitDisplayingFullscreen;
  return !!document.fullscreenElement;
}

export function toggleFullscreen(): void {
  if (videoFullscreen) {
    const video = playerVideo();
    if (video?.webkitDisplayingFullscreen) video.webkitExitFullscreen?.();
    else video?.webkitEnterFullscreen?.();
    return;
  }
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen().catch(() => undefined);
}

export function onFullscreenChange(listener: () => void): () => void {
  if (videoFullscreen) {
    // The video's full-screen events do not bubble; capture them on the document.
    document.addEventListener('webkitbeginfullscreen', listener, true);
    document.addEventListener('webkitendfullscreen', listener, true);
    return () => {
      document.removeEventListener('webkitbeginfullscreen', listener, true);
      document.removeEventListener('webkitendfullscreen', listener, true);
    };
  }
  document.addEventListener('fullscreenchange', listener);
  return () => document.removeEventListener('fullscreenchange', listener);
}

/** Mobile Safari draws its own close button over the top-leading corner of element full screen. */
export function safariFullscreenInset(
  fullscreen: boolean,
  userAgent: string,
  maxTouchPoints: number
): number {
  if (!fullscreen) return 0;
  const apple = /iPhone|iPad|Macintosh/.test(userAgent) && maxTouchPoints > 1;
  const safari = /Safari\//.test(userAgent) && !/CriOS|FxiOS|EdgiOS/.test(userAgent);
  return apple && safari ? 44 : 0;
}

export function fullscreenChromeInset(fullscreen: boolean): number {
  if (typeof navigator === 'undefined') return 0;
  return safariFullscreenInset(fullscreen, navigator.userAgent, navigator.maxTouchPoints ?? 0);
}
