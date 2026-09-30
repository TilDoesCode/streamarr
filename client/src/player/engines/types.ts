import type { ComponentType } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

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
  | { type: 'error'; reason: string }
  | { type: 'ended' }
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
  subscribe(listener: (event: EngineEvent) => void): () => void;
  getSnapshot(): EngineSnapshot;
  /** Stops decoding before the Surface unmounts (libVLC must not be released while it decodes). */
  shutdown?(): Promise<void>;
  release(): void;
}
