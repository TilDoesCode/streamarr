type Orientation = Pick<typeof import('expo-screen-orientation'), 'unlockAsync'>;

/** Handheld cold start: release any orientation lock, so UIKit lays the first screen out for the held device (Q1-48). */
export function releaseLaunchOrientation(
  orientation: () => Promise<Orientation>,
  platform: { os: string; isTV: boolean }
): void {
  if (platform.os === 'web' || platform.isTV) return;
  void orientation()
    .then((o) => o.unlockAsync())
    .catch(() => undefined);
}
