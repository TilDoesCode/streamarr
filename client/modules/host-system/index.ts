import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

export type HostTheme = 'default' | 'streamybox';

/** Hardware facts read once at startup (Android); every field may be missing on other hosts. */
export type HostDevice = {
  socModel?: string | null;
  hardware?: string | null;
  boardPlatform?: string | null;
  totalMemoryMb?: number;
  lowRam?: boolean;
  cores?: number;
  maxCpuMhz?: number;
  /** Developer options "Animator duration scale"; 0 = animations removed. */
  animatorScale?: number;
  mediaPerformanceClass?: number;
};

type HostSystemModule = { theme?: string; device?: HostDevice };

// Android only; every other platform (and a build without the module) is a plain host.
const native =
  Platform.OS === 'android' ? requireOptionalNativeModule<HostSystemModule>('HostSystem') : null;

/** Theme of the system the app runs in, resolved synchronously at startup. */
export const hostTheme: HostTheme = native?.theme === 'streamybox' ? 'streamybox' : 'default';

/** Hardware of the host (empty off Android or without the module). */
export const hostDevice: HostDevice = native?.device ?? {};
