type Orientation = Pick<
  typeof import('expo-screen-orientation'),
  'lockAsync' | 'unlockAsync' | 'OrientationLock'
>;

/** Phone player: landscape while open; on close a portrait app is turned back before rotation is freed. */
export function lockPlayerLandscape(orientation: Promise<Orientation>, wasPortrait: boolean) {
  void orientation.then((o) => o.lockAsync(o.OrientationLock.LANDSCAPE)).catch(() => undefined);
  return () =>
    void orientation
      .then(async (o) => {
        if (wasPortrait) await o.lockAsync(o.OrientationLock.PORTRAIT_UP);
        await o.unlockAsync();
      })
      .catch(() => undefined);
}
