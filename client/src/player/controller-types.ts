import type { DeviceProfile } from '@modules/media-caps';

import type { ApiClient } from '@/api/client';
import type { ErrorParams } from '@/api/errors';
import type { EngineKind } from '@/player/engines';
import type { Playback, PlaybackPreferences } from '@/player/playback-api';
import type { ErrorCategory } from '@/player/recovery/classify';
import type { Attempt } from '@/player/recovery/ladder';
import type { StatusHint } from '@/player/recovery/runner';

export type ControllerPhase =
  'starting' | 'resume' | 'playing' | 'switching' | 'failed' | 'stopped';
export type AudioTrack = NonNullable<NonNullable<Playback['mediaInfo']>['audioTracks']>[number];
export type SubtitleTrack = NonNullable<
  NonNullable<Playback['mediaInfo']>['subtitleTracks']
>[number];
export type NoticeKind =
  | 'stepDown'
  | 'switchFailed'
  | 'offline'
  | 'otherVersion'
  | 'audioFallback'
  | 'subtitleFailed'
  | 'subtitleNotDeliverable'
  | 'audioRestarted'
  | 'otherTab'
  | 'otherAudioTrack';
export type Notice = { kind: NoticeKind; params?: ErrorParams; id: number };
/** `status`: HTTP status of the failed request (0 = no answer), when the failure was an API call. */
export type FailedState = {
  code: string;
  params?: ErrorParams;
  status?: number;
  actions: string[];
  category?: ErrorCategory;
  /** The recovery steps that ran before the card ("What was tried"). */
  tried?: Attempt[];
  /** A specific line under the card text, e.g. where the file ends. */
  hint?: StatusHint;
};
/** Connectivity source (NetInfo unless a test passes its own); `kind` (wifi, cellular …) reveals a handover. */
export type NetworkSource = {
  subscribe(listener: (online: boolean, kind?: string) => void): () => void;
  /** Reads the state again now (NetInfo.fetch): a late or missed event must not hold the offline hint (S6v). */
  refresh?(): Promise<boolean>;
};
/** One audio switch: in the session (rendition) or via `/switch`; `ms` until the new track plays on. */
export type AudioSwitchSample = {
  via: 'session' | 'server';
  from: number | null;
  to: number;
  positionBefore: number;
  positionAfter?: number;
  ms?: number;
  /** Why this switch failed / why it replaced a failed in-session switch. */
  error?: string;
  fallback?: string;
};
export type PendingAudio = {
  sample: AudioSwitchSample;
  at: number;
  engineId: string | null;
  confirmed: boolean;
  settle: (ok: boolean) => void;
};

export type ControllerOptions = {
  client: ApiClient;
  accountId: string;
  serverUrl: string;
  profile: DeviceProfile;
  nativeEngine: EngineKind;
  workId: string;
  releaseId?: string;
  /** Seconds; `undefined` asks resume vs from the start when the server has a saved position. */
  startSeconds?: number;
  preferences?: PlaybackPreferences;
  network?: NetworkSource;
};
