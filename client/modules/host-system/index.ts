import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

export type HostTheme = 'default' | 'streamybox';

type HostSystemModule = { theme?: string };

// Android only; every other platform (and a build without the module) is a plain host.
const native =
  Platform.OS === 'android' ? requireOptionalNativeModule<HostSystemModule>('HostSystem') : null;

/** Theme of the system the app runs in, resolved synchronously at startup. */
export const hostTheme: HostTheme = native?.theme === 'streamybox' ? 'streamybox' : 'default';
