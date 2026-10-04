import { deviceSettings } from '@/lib/storage';

import { primaryLanguage } from './audio-renditions';

const key = (accountId: string) => `player.audioLanguage.${accountId}`;

/** The audio language this account last picked in the player; the next start prefers it. */
export function rememberedAudioLanguage(accountId: string): string | undefined {
  return deviceSettings.getString(key(accountId)) || undefined;
}

export function rememberAudioLanguage(
  accountId: string,
  language: string | null | undefined
): void {
  const primary = primaryLanguage(language);
  if (primary) deviceSettings.set(key(accountId), primary);
}

const singleAudio = new Set<string>();

/** Releases seen with at most one audio track: their next start sends no remembered language. */
export function noteAudioTracks(releaseId: string | null | undefined, count: number): void {
  if (releaseId && count <= 1) singleAudio.add(releaseId);
}

export function isSingleAudio(releaseId: string | null | undefined): boolean {
  return !!releaseId && singleAudio.has(releaseId);
}
