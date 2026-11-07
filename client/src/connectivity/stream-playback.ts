/** Whether a server stream plays right now: without the server it gives way to the offline shell, a local file does not. */
let streaming = 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

export function holdStreamPlayback(): () => void {
  streaming += 1;
  notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    streaming -= 1;
    notify();
  };
}

export const subscribeStreamPlayback = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const isStreamPlaybackActive = (): boolean => streaming > 0;
