import type {
  CodecLogEntry,
  DeviceProfile,
  ExitRecord,
  MediaCapsReport,
} from './src/MediaCaps.types';
import { Platform } from 'react-native';

import MediaCaps from './src/MediaCapsModule';
import { buildDeviceProfile, type ProfileOptions } from './src/profile';

export * from './src/MediaCaps.types';
export {
  buildDeviceProfile,
  chooseDecoders,
  passthroughDiagnosis,
  SOFTWARE_MAX_HEIGHT,
} from './src/profile';
export type { DecoderChoice, PassthroughDiagnosis, ProfileOptions } from './src/profile';

/** Raw decoder, display and audio-output capabilities of this device. */
export function getCapabilitiesAsync(): Promise<MediaCapsReport> {
  return MediaCaps.getCapabilitiesAsync();
}

/** Dev diagnostics: this process's codec events via logcat (Android 13+ asks the user once; empty elsewhere). */
export function readCodecLogAsync(sinceEpochMs: number): Promise<CodecLogEntry[]> {
  return MediaCaps.readCodecLogAsync(sinceEpochMs);
}

/** Why this app's last processes ended, newest first (Android 11+; empty on Apple and web). */
export function getExitHistoryAsync(max = 5): Promise<ExitRecord[]> {
  return MediaCaps.getExitHistoryAsync(max);
}

/** Capabilities plus the DeviceProfile to send with `POST /api/v1/viewer/playback`. */
export async function getDeviceProfileAsync(
  options: ProfileOptions
): Promise<{ report: MediaCapsReport; profile: DeviceProfile }> {
  const report = await getCapabilitiesAsync();
  return { report, profile: buildDeviceProfile(report, options) };
}

/** Android: the audio output changed (device, HDMI plug/EDID, surround setting); a no-op elsewhere. */
export function addAudioOutputListener(listener: () => void): { remove(): void } {
  if (Platform.OS !== 'android' || typeof MediaCaps.addListener !== 'function')
    return { remove: () => undefined };
  return MediaCaps.addListener('onAudioOutputChange', listener);
}
