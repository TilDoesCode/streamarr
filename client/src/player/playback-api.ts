import type { DeviceProfile } from '@modules/media-caps';

import { unwrap, type ApiClient } from '@/api/client';
import type { components } from '@/api/schema';

export type Playback = components['schemas']['PlaybackResponse'];
export type PlaybackPreferences = components['schemas']['PlaybackPreferencesDto'];
export type PlaybackSwitch = components['schemas']['PlaybackSwitchRequest'];

export type StartRequest = {
  workId: string;
  releaseId?: string;
  startPositionTicks?: number;
  audioStreamIndex?: number;
  subtitleStreamIndex?: number;
  device: DeviceProfile;
  preferences?: PlaybackPreferences;
};

export const TICKS_PER_SECOND = 10_000_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    });
  });
}

export function startPlayback(client: ApiClient, request: StartRequest, signal?: AbortSignal) {
  return unwrap(client.POST('/api/v1/viewer/playback', { body: request, signal }));
}

/** Polls until `ready` or `failed` (the server suggests the delay), reporting every state change. */
export async function waitForPlayback(
  client: ApiClient,
  playback: Playback,
  onUpdate: (playback: Playback) => void,
  signal?: AbortSignal
): Promise<Playback> {
  let current = playback;
  onUpdate(current);
  while (current.state !== 'ready' && current.state !== 'failed') {
    await sleep(Math.max(100, current.pollAfterMs ?? 500), signal);
    current = await unwrap(
      client.GET('/api/v1/viewer/playback/{playbackId}', {
        params: { path: { playbackId: playback.playbackId ?? '' } },
        signal,
      })
    );
    onUpdate(current);
  }
  return current;
}

export function switchPlayback(client: ApiClient, playbackId: string, body: PlaybackSwitch) {
  return unwrap(
    client.POST('/api/v1/viewer/playback/{playbackId}/switch', {
      params: { path: { playbackId } },
      body,
    })
  );
}

export async function stopPlayback(client: ApiClient, playbackId: string): Promise<void> {
  await client.POST('/api/v1/viewer/playback/{playbackId}/stop', {
    params: { path: { playbackId } },
  });
}

export async function reportProgress(
  client: ApiClient,
  playback: Playback,
  event: 'start' | 'progress' | 'stop',
  position: number,
  duration: number
): Promise<void> {
  await client.POST('/api/v1/viewer/watch/progress', {
    body: {
      event,
      workId: playback.workId,
      playbackId: playback.playbackId,
      positionTicks: Math.round(position * TICKS_PER_SECOND),
      durationTicks: duration ? Math.round(duration * TICKS_PER_SECOND) : null,
    },
  });
}

/** Absolute media URL: the server returns capability paths relative to its origin. */
export function mediaUrl(serverUrl: string, path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${serverUrl.replace(/\/+$/, '')}${path.startsWith('/') ? '' : '/'}${path}`;
}
