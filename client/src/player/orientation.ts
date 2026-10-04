import { Dimensions } from 'react-native';

type Orientation = Pick<
  typeof import('expo-screen-orientation'),
  'lockAsync' | 'unlockAsync' | 'OrientationLock'
>;

const windowIsPortrait = () => {
  const { width, height } = Dimensions.get('window');
  return height > width;
};

/** How long a portrait turn may take before rotation is freed anyway. */
const TURN_TIMEOUT_MS = 1500;
const TURN_POLL_MS = 100;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** iOS unlock keeps the window as it is (and the module already reports portrait): wait for the window to turn. */
async function untilPortrait(isPortrait: () => boolean): Promise<void> {
  for (let waited = 0; waited < TURN_TIMEOUT_MS; waited += TURN_POLL_MS) {
    if (isPortrait()) return;
    await wait(TURN_POLL_MS);
  }
}

/** Phone player: landscape while open; on close a portrait app is turned back before rotation is freed. */
export function lockPlayerLandscape(
  orientation: Promise<Orientation>,
  wasPortrait: boolean,
  isPortrait: () => boolean = windowIsPortrait
) {
  void orientation.then((o) => o.lockAsync(o.OrientationLock.LANDSCAPE)).catch(() => undefined);
  return () =>
    void orientation
      .then(async (o) => {
        if (wasPortrait) {
          await o.lockAsync(o.OrientationLock.PORTRAIT_UP);
          await untilPortrait(isPortrait);
        }
        await o.unlockAsync();
      })
      .catch(() => undefined);
}
