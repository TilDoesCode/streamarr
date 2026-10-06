import type { DeviceProfile, MediaPlatform } from '@modules/media-caps';
import { Platform } from 'react-native';

/** What every supported device plays: H.264 up to 1080p, AAC stereo, HLS and MP4 (the server converts the rest). */
export function fallbackProfile(platform: MediaPlatform): DeviceProfile {
  return {
    platform,
    engines: [
      {
        engine: platform === 'web' ? 'web' : 'native',
        containers: ['mp4'],
        videoCodecs: [{ codec: 'h264', maxWidth: 1920, maxHeight: 1080, maxBitDepth: 8 }],
        audioCodecs: [{ codec: 'aac', maxChannels: 2 }],
        subtitleFormats: ['webvtt'],
        hls: true,
        maxAudioChannels: 2,
      },
    ],
    vlcAvailable: false,
  };
}

function platformNow(): MediaPlatform {
  if (Platform.OS === 'web') return 'web';
  if (Platform.OS === 'ios') return Platform.isTV ? 'tvos' : Platform.isPad ? 'ipados' : 'ios';
  return Platform.isTV ? 'androidtv' : 'android';
}

/** The measured profile, or the conservative one when measuring fails (E16): the player still starts. */
export async function profileOrFallback(
  load: () => Promise<{ profile: DeviceProfile }>
): Promise<DeviceProfile> {
  try {
    return (await load()).profile;
  } catch (error) {
    if (__DEV__)
      console.warn('[player] device caps failed, playing with the fallback profile', error);
    return fallbackProfile(platformNow());
  }
}

/** Creates the player with the device's profile (or the fallback) and starts it; `make` returns null once the screen left. */
export async function createPlayer<T extends { start(): Promise<void> }>(
  load: () => Promise<{ profile: DeviceProfile }>,
  make: (profile: DeviceProfile) => T | null
): Promise<T | null> {
  const player = make(await profileOrFallback(load));
  void player?.start();
  return player;
}
