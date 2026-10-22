import { NativeModule, requireNativeModule } from 'expo';

import type { CodecLogEntry, ExitRecord, MediaCapsReport } from './MediaCaps.types';

declare class MediaCapsNativeModule extends NativeModule {
  getCapabilitiesAsync(): Promise<MediaCapsReport>;
  readCodecLogAsync(sinceEpochMs: number): Promise<CodecLogEntry[]>;
  getExitHistoryAsync(max: number): Promise<ExitRecord[]>;
}

export default requireNativeModule<MediaCapsNativeModule>('MediaCaps');
