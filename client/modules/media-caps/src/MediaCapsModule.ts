import { NativeModule, requireNativeModule } from 'expo';

import type { CodecLogEntry, MediaCapsReport } from './MediaCaps.types';

type Events = { onAudioOutputChange: (event: { reason: string }) => void };

declare class MediaCapsNativeModule extends NativeModule<Events> {
  getCapabilitiesAsync(): Promise<MediaCapsReport>;
  readCodecLogAsync(sinceEpochMs: number): Promise<CodecLogEntry[]>;
}

export default requireNativeModule<MediaCapsNativeModule>('MediaCaps');
