import { createMMKV } from 'react-native-mmkv';

/** Device-wide settings (not per account): language override, UI preferences. Web: localStorage. */
export const deviceSettings = createMMKV({ id: 'streamarr.device' });
