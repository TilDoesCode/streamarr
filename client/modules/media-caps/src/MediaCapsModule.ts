import { NativeModule, requireNativeModule } from 'expo';

import type { CodecLogEntry, MediaCapsReport } from './MediaCaps.types';

declare class MediaCapsNativeModule extends NativeModule {
  getCapabilitiesAsync(): Promise<MediaCapsReport>;
  readCodecLogAsync(sinceEpochMs: number): Promise<CodecLogEntry[]>;
}

export default requireNativeModule<MediaCapsNativeModule>('MediaCaps');
