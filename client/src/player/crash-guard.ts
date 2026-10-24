/** Errors thrown outside React rendering (engine events, timers, native callbacks) while a playback runs. */
type GlobalHandler = (error: unknown, isFatal?: boolean) => void;
type ErrorUtilsLike = {
  getGlobalHandler(): GlobalHandler;
  setGlobalHandler(handler: GlobalHandler): void;
};
export type PlaybackErrorSink = (error: Error) => void;

const sinks: PlaybackErrorSink[] = [];
let installed = false;

function errorUtils(): ErrorUtilsLike | undefined {
  const scope = globalThis as { ErrorUtils?: ErrorUtilsLike };
  return typeof scope.ErrorUtils?.setGlobalHandler === 'function' ? scope.ErrorUtils : undefined;
}

const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

/** Metro's split-bundle import first requires the chunk synchronously and loads it only when that throws. */
export function isChunkProbe(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Requiring unknown module');
}

/** Hands an error to the newest playback; false when none runs (or its sink failed). */
export function reportPlaybackError(error: unknown): boolean {
  const sink = sinks[sinks.length - 1];
  if (!sink) return false;
  try {
    sink(asError(error));
    return true;
  } catch {
    return false;
  }
}

/** Wraps React Native's global handler once: while a playback runs, its card shows the error and the app stays up. */
export function installPlaybackCrashGuard(): void {
  const utils = errorUtils();
  if (installed || !utils) return;
  installed = true;
  const previous = utils.getGlobalHandler();
  utils.setGlobalHandler((error, isFatal) => {
    if (isChunkProbe(error) || !reportPlaybackError(error)) return previous(error, isFatal);
    // Release builds would end the process on a fatal error; dev builds still list it (non-fatal, no red screen).
    if (__DEV__) previous(error, false);
    else console.error('[player] error during playback', error);
  });
}

/** Routes uncaught errors to `sink` until the returned function runs (one per mounted player). */
export function guardPlayback(sink: PlaybackErrorSink): () => void {
  installPlaybackCrashGuard();
  sinks.push(sink);
  return () => {
    const index = sinks.lastIndexOf(sink);
    if (index >= 0) sinks.splice(index, 1);
  };
}

/** Test seam: forget the installation and every sink. */
export function resetPlaybackCrashGuard(): void {
  installed = false;
  sinks.length = 0;
}
