import { Dimensions } from 'react-native';

type Orientation = Pick<
  typeof import('expo-screen-orientation'),
  'lockAsync' | 'unlockAsync' | 'OrientationLock'
>;

const windowIsPortrait = () => {
  const { width, height } = Dimensions.get('window');
  return height > width;
};

/** Loaded lazily: expo-screen-orientation has no tvOS native module. */
export const screenOrientation = () => import('expo-screen-orientation');

/** How long a portrait turn may take before rotation is freed anyway. */
const TURN_TIMEOUT_MS = 1500;
/** UIKit turns the window with the dismissal; unlocking before that turn settled sends it back to landscape (Q2-07). */
const RELEASE_TIMEOUT_MS = 3000;
const RELEASE_SETTLE_MS = 1000;
const TURN_POLL_MS = 100;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** iOS unlock keeps the window as it is (and the module already reports portrait): wait for the window to turn. */
async function untilPortrait(isPortrait: () => boolean, timeout = TURN_TIMEOUT_MS): Promise<void> {
  for (let waited = 0; waited < timeout; waited += TURN_POLL_MS) {
    if (isPortrait()) return;
    await wait(TURN_POLL_MS);
  }
}

/** The phone player's orientation: `restore` turns a portrait app back before the screen goes, `release` frees rotation after. */
export type PlayerOrientation = { restore(): Promise<void>; release(): void };

/** The player that holds the lock now: a player replacing another (up-next) keeps landscape (Q2-07). */
let owner: object | null = null;

/** Phone player: landscape while open; every close turns a portrait app back first, then leaves, then frees rotation (Q2-07). */
export function lockPlayerLandscape(
  orientation: Promise<Orientation>,
  wasPortrait: boolean,
  isPortrait: () => boolean = windowIsPortrait
): PlayerOrientation {
  const token = {};
  owner = token;
  const locked = orientation
    .then((o) => o.lockAsync(o.OrientationLock.LANDSCAPE))
    .catch(() => undefined);
  let turned: Promise<void> | null = null;
  let freed = false;
  const restore = () =>
    (turned ??= orientation
      .then(async (o) => {
        await locked;
        if (!wasPortrait || owner !== token) return;
        await o.lockAsync(o.OrientationLock.PORTRAIT_UP);
        await untilPortrait(isPortrait);
      })
      .catch(() => undefined));
  const release = () => {
    if (freed) return;
    freed = true;
    void restore()
      .then(async () => {
        if (!wasPortrait || owner !== token) return;
        await untilPortrait(isPortrait, RELEASE_TIMEOUT_MS);
        await wait(RELEASE_SETTLE_MS);
      })
      .then(() => orientation)
      .then((o) => {
        if (owner !== token) return;
        owner = null;
        return o.unlockAsync();
      })
      .catch(() => undefined);
  };
  return { restore, release };
}
