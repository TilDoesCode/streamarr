import { NativeModule, requireNativeModule } from 'expo';

import type { CodecLogEntry, ExitRecord, MediaCapsReport } from './MediaCaps.types';

type Events = { onAudioOutputChange: (event: { reason: string }) => void };

declare class MediaCapsNativeModule extends NativeModule<Events> {
  getCapabilitiesAsync(): Promise<MediaCapsReport>;
  readCodecLogAsync(sinceEpochMs: number): Promise<CodecLogEntry[]>;
  getExitHistoryAsync(max: number): Promise<ExitRecord[]>;
}

export default requireNativeModule<MediaCapsNativeModule>('MediaCaps');
