import type { ComponentType } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

import type { EngineHealth } from '../health/types';

/** Engine implementations behind the one player interface. */
export type EngineKind = 'expo-video' | 'vlc' | 'web';

export type EngineState =
  'idle' | 'loading' | 'playing' | 'paused' | 'buffering' | 'ended' | 'error';

export type EngineTrack = {
  /** Engine-specific id used by `setAudioTrack` / `setSubtitleTrack`. */
  id: string;
  label: string;
  language?: string;
  codec?: string;
  /** A forced-narrative subtitle (Safari exposes HLS FORCED=YES renditions as kind "forced"). */
  forced?: boolean;
  selected: boolean;
};

export type EngineVideoInfo = {
  width?: number;
  height?: number;
  codec?: string;
  bitrate?: number;
  frameRate?: number;
  /** `sdr`, `pq` or `hlg` when the engine reports the video range. */
  range?: string;
};

export type EngineTracks = {
  audio: EngineTrack[];
  subtitles: EngineTrack[];
  video?: EngineVideoInfo;
};

export type EngineStats = {
  decoder?: string;
  droppedFrames?: number;
  totalFrames?: number;
  bandwidth?: number;
};

export type EngineEvent =
  | { type: 'state'; state: EngineState }
  | { type: 'time'; position: number; duration: number; buffered?: number }
  | { type: 'buffering'; buffering: boolean }
  | { type: 'tracks'; tracks: EngineTracks }
  | { type: 'firstFrame' }
  /** `status`: HTTP status of the failed media request when the engine knows it (0 = no answer). */
  | { type: 'error'; reason: string; status?: number }
  | { type: 'ended' }
  | { type: 'pip'; active: boolean }
  /** The viewer paused or resumed outside the app's controls (system full-screen player, lock screen). */
  | { type: 'userPlayback'; paused: boolean }
  /** An audio rendition failed to load; `code` is the server's error code when known. */
  | { type: 'audioError'; code: string }
  /** The browser refused to start with sound (`muted`) or at all (`blocked`). */
  | { type: 'autoplay'; result: 'muted' | 'blocked' }
  | { type: 'stats'; stats: EngineStats };

export type EngineSource = {
  uri: string;
  /** HLS master playlist (remux/transcode) or a progressive file (direct play). */
  kind: 'progressive' | 'hls';
  /** Seconds. */
  startPosition?: number;
  title?: string;
};

export type EngineSnapshot = {
  state: EngineState;
  position: number;
  duration: number;
  buffered: number;
  tracks: EngineTracks;
  stats: EngineStats;
};

export type SurfaceProps = { style?: StyleProp<ViewStyle>; fit?: 'contain' | 'cover' };

/** One playback engine: commands in, events out, and the view that renders its picture. */
export interface PlayerEngine {
  readonly kind: EngineKind;
  readonly Surface: ComponentType<SurfaceProps>;
  load(source: EngineSource): void;
  play(): void;
  pause(): void;
  /** Seconds. */
  seek(position: number): void;
  setAudioTrack(id: string): void;
  /** `null` turns subtitles off. */
  setSubtitleTrack(id: string | null): void;
  setMuted?(muted: boolean): void;
  /** Picture-in-picture (iPhone/iPad and Android phones, expo-video): entered by `startPictureInPicture` or on leaving the app. */
  readonly supportsPictureInPicture?: boolean;
  startPictureInPicture?(): void;
  /** AirPlay route picker (AVPlayer on iPhone/iPad). */
  readonly supportsAirPlay?: boolean;
  subscribe(listener: (event: EngineEvent) => void): () => void;
  getSnapshot(): EngineSnapshot;
  /** Health probe for the watchdog (state-matrix § 2 a); engines without one get clock rules only. */
  readHealth?(): Promise<EngineHealth>;
  /** Stops decoding before the Surface unmounts (libVLC must not be released while it decodes). */
  shutdown?(): Promise<void>;
  release(): void;
}
