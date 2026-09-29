/** Platform keys of the M1.3 DeviceProfile. */
export type MediaPlatform = 'ios' | 'ipados' | 'tvos' | 'android' | 'androidtv' | 'web';

export type VideoDecoderInfo = {
  name: string;
  codec: string;
  mimeType?: string;
  /** Hardware-accelerated decoder (Android `isHardwareAccelerated`, VideoToolbox, web `powerEfficient`). */
  hardware: boolean;
  softwareOnly: boolean;
  vendor?: boolean;
  alias?: boolean;
  canonicalName?: string;
  /** False when the platform player cannot use this decoder at all (Apple: non-H.264 without hardware). */
  usable?: boolean;
  maxWidth?: number | null;
  maxHeight?: number | null;
  maxFrameRateAtMaxSize?: number | null;
  maxBitDepth: number;
  /** HDR formats the decoder handles (before intersecting with the display). */
  hdrFormats: string[];
  profiles?: string[];
  secure?: boolean;
  tunneled?: boolean;
  smooth?: boolean;
};

export type AudioDecoderInfo = {
  name: string;
  codec: string;
  mimeType?: string;
  hardware: boolean;
  softwareOnly: boolean;
  maxChannels: number;
};

export type DisplayInfo = {
  width?: number;
  height?: number;
  refreshRate?: number;
  /** `hdr10`, `hlg`, `dolbyvision`, `hdr10plus` as reported by the display. */
  hdrTypes: string[];
  isHdr?: boolean;
  modes?: string[];
  edrHeadroom?: number;
};

export type AudioOutputDevice = {
  type: string;
  name?: string | null;
  channelCounts: number[];
  encodings?: number[];
};

export type AudioOutputInfo = {
  devices: AudioOutputDevice[];
  /** Encodings the output accepts as a bitstream (`ac3`, `eac3`, `eac3-joc`, `dts`, `dts-hd`, `truehd`, `ac4`). */
  passthrough: string[];
  maxChannels: number;
  api: string;
};

export type WebInfo = {
  browser: string;
  userAgent: string;
  mse: boolean;
  managedMse: boolean;
  nativeHls: boolean;
  mediaCapabilities: boolean;
};

export type DeviceInfo = {
  manufacturer?: string;
  model?: string;
  osVersion?: string;
  sdkInt?: number;
  hardware?: string;
  isTV: boolean;
  isEmulator: boolean;
  abis?: string[];
};

/** Raw capabilities as the native (or web) module reports them. */
export type MediaCapsReport = {
  platform: MediaPlatform;
  device: DeviceInfo;
  videoDecoders: VideoDecoderInfo[];
  audioDecoders: AudioDecoderInfo[];
  display: DisplayInfo;
  audioOutput: AudioOutputInfo;
  web?: WebInfo;
};

/** One line of the player's own codec log (Android only; empty elsewhere). */
export type CodecLogEntry = {
  time: number;
  tag: string;
  event: 'decoderInitialized' | 'droppedFrames' | 'allocate' | 'release' | 'vlcCodec';
  codec?: string;
  kind?: string;
  count?: number;
  message?: string;
};

export type VideoCodecProfile = {
  codec: string;
  maxWidth?: number;
  maxHeight?: number;
  maxBitDepth?: number;
  hdrFormats?: string[];
};

export type AudioCodecProfile = { codec: string; maxChannels?: number; passthrough?: boolean };

export type EngineName = 'native' | 'web' | 'vlc';

export type EngineProfile = {
  engine: EngineName;
  containers: string[];
  videoCodecs: VideoCodecProfile[];
  audioCodecs: AudioCodecProfile[];
  subtitleFormats: string[];
  hls: boolean;
  maxAudioChannels: number;
};

/** The `device` object of `POST /api/v1/viewer/playback` (DeviceProfileDto). */
export type DeviceProfile = {
  platform: MediaPlatform;
  engines: EngineProfile[];
  vlcAvailable: boolean;
  maxBitrateKbps?: number;
};
