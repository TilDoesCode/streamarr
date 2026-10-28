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

export type DirectProfile = { format: string; iec61937: boolean; channels: number };

/** Android `encoded_surround_output` (Settings › Sound › Surround / Streamybox Tonformat). */
export type SurroundMode = 'auto' | 'never' | 'always' | 'manual' | 'unknown';

export type AudioOutputInfo = {
  devices: AudioOutputDevice[];
  /** Encodings the player bitstreams (`ac3`, `eac3`, `eac3-joc`, `dts`, `dts-hd`, `truehd`, `ac4`); Android: Media3's own verdict. */
  passthrough: string[];
  maxChannels: number;
  api: string;
  /** Android: most channels the player bitstreams per format (below the format's full count it is not in `passthrough`). */
  passthroughChannels?: Record<string, number>;
  /** Android: bitstream formats the HDMI output device lists (EDID). */
  hdmiEncodings?: string[];
  /** Android 13+: direct profiles of the routed output. */
  directProfiles?: DirectProfile[];
  /** Android: ACTION_HDMI_AUDIO_PLUG encodings; null when no HDMI plug is reported. */
  plugEncodings?: string[] | null;
  surroundMode?: SurroundMode;
  /** Android: the television ui mode, the only one where Media3 asks the direct-playback APIs. */
  tvMode?: boolean;
  routedDevice?: string | null;
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
  /**
   * Streamybox (`dev.streamybox.dolby_vision`): the system's own player (`dev.streamybox.player`) decodes
   * Dolby Vision HEVC (profiles 5/8.1/8.4) and tone-maps it to HDR10 or SDR. A player capability, not a DV
   * display: the HDMI sink can stay HDR10 and there is no `video/dolby-vision` MediaCodec.
   */
  streamyboxDolbyVision?: boolean;
};

/** Why an earlier process of this app ended (Android 11+ ApplicationExitInfo; empty elsewhere). */
export type ExitRecord = {
  /** Epoch milliseconds. */
  time: number;
  /** `crash`, `crashNative`, `anr`, `lowMemory`, `signaled`, `userRequested`, `exitSelf`, … */
  reason: string;
  status: number;
  /** ActivityManager importance at exit: 100 = foreground, 125 = foreground service, 200 = visible. */
  importance: number;
  description?: string | null;
  pssKb?: number;
  rssKb?: number;
  /** The start of the ANR trace (text); null for every other reason. */
  trace?: string | null;
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
