/** What an engine probe can measure (state-matrix § 2 a); `undefined` = the platform cannot tell, never guessed. */
export type EngineHealth = {
  /** Monotonic count of frames on screen. */
  framesPresented?: number;
  framesDropped?: number;
  /** Frames the decoder produced (VLC, Exo): decoded but never presented = no picture (D16, D23). */
  framesDecoded?: number;
  /** Monotonic bytes/buffers of audio rendered or decoded. */
  audioProgress?: number;
  /** A picture is on screen (first frame seen, enough data for the current frame). */
  readyForDisplay?: boolean;
  hasVideoTrack?: boolean;
  hasAudioTrack?: boolean;
  bandwidthBps?: number;
  /** The last video segment: server wait until the first byte, transfer after it, and its size (C08 vs C03). */
  fetch?: { waitMs: number; transferMs: number; bytes: number };
  /** Media seconds a transcode delivered per second the client waited, over the last segments (< 1 = slower than real time). */
  conversionRate?: number;
  /** AirPlay / Remote Playback: picture checks off. */
  external?: boolean;
  /** Engine clock read directly, not from time events (D35). */
  nativePosition?: number;
  /** Brightest sampled pixel (0–255) where the picture can be read (same-origin data only). */
  luma?: number;
};

export type HealthVerdict =
  'ok' | 'clock-frozen' | 'picture-black' | 'picture-frozen' | 'audio-silent' | 'slideshow';

export type HealthFinding = {
  verdict: HealthVerdict;
  /** When the condition was first seen (ms). */
  since: number;
  /** Escalate now (ladder) or only explain (hint). */
  level: 'hint' | 'ladder';
  evidence: Record<string, number | boolean | undefined>;
};
