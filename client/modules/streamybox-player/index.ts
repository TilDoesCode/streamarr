import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

type StreamyboxPlayerModule = { available?: boolean; isAvailable?: () => boolean };

// Android only: the module answers whether dev.streamybox.player exposes its render service.
const native =
  Platform.OS === 'android'
    ? requireOptionalNativeModule<StreamyboxPlayerModule>('StreamyboxPlayer')
    : null;

let cached: boolean | null = null;

/** Whether the Streamybox player's embedded render service is installed (synchronous, cached). */
export function streamyboxInstalled(): boolean {
  if (cached === null) cached = native?.isAvailable?.() ?? native?.available ?? false;
  return cached;
}

/** Re-reads the native answer (after a package install while the app runs). */
export async function probeStreamyboxInstalled(): Promise<boolean> {
  cached = native?.isAvailable?.() ?? native?.available ?? false;
  return cached;
}
