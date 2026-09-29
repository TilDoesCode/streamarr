import type { CodecLogEntry, DeviceProfile, MediaCapsReport } from './src/MediaCaps.types';
import MediaCaps from './src/MediaCapsModule';
import { buildDeviceProfile, type ProfileOptions } from './src/profile';

export * from './src/MediaCaps.types';
export { buildDeviceProfile, chooseDecoders, SOFTWARE_MAX_HEIGHT } from './src/profile';
export type { DecoderChoice, ProfileOptions } from './src/profile';

/** Raw decoder, display and audio-output capabilities of this device. */
export function getCapabilitiesAsync(): Promise<MediaCapsReport> {
  return MediaCaps.getCapabilitiesAsync();
}

/** Dev diagnostics: this process's codec events via logcat (Android 13+ asks the user once; empty elsewhere). */
export function readCodecLogAsync(sinceEpochMs: number): Promise<CodecLogEntry[]> {
  return MediaCaps.readCodecLogAsync(sinceEpochMs);
}

/** Capabilities plus the DeviceProfile to send with `POST /api/v1/viewer/playback`. */
export async function getDeviceProfileAsync(
  options: ProfileOptions
): Promise<{ report: MediaCapsReport; profile: DeviceProfile }> {
  const report = await getCapabilitiesAsync();
  return { report, profile: buildDeviceProfile(report, options) };
}
