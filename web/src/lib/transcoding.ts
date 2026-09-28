import type {
  AcceleratorResponse,
  GpuDeviceResponse,
  TranscodeJobResponse,
  TranscodePlanResponse,
  TranscodingCapabilitiesResponse,
  TranscodingConfigResponse,
} from "@/api/types";

/** Semantic colour of a status chip; mapped to light/dark classes in {@link toneBadgeClass}. */
export type Tone = "success" | "warning" | "danger" | "info" | "muted";

export const toneBadgeClass: Record<Tone, string> = {
  success: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  warning: "border-transparent bg-amber-500/15 text-amber-800 dark:text-amber-300",
  danger: "border-transparent bg-red-500/15 text-red-700 dark:text-red-300",
  info: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-300",
  muted: "border-transparent bg-muted text-muted-foreground",
};

export const toneTextClass: Record<Tone, string> = {
  success: "text-emerald-600 dark:text-emerald-400",
  warning: "text-amber-600 dark:text-amber-400",
  danger: "text-red-600 dark:text-red-400",
  info: "text-sky-600 dark:text-sky-400",
  muted: "text-muted-foreground",
};

const ACCELERATION_LABELS: Record<string, string> = {
  none: "Software (CPU)",
  videotoolbox: "Apple VideoToolbox",
  vaapi: "VA-API (Intel / AMD)",
  qsv: "Intel Quick Sync (QSV)",
  nvenc: "NVIDIA NVENC / NVDEC",
};

const ACCELERATION_SHORT: Record<string, string> = {
  none: "Software",
  videotoolbox: "VideoToolbox",
  vaapi: "VA-API",
  qsv: "QSV",
  nvenc: "NVENC",
};

export function accelerationLabel(id?: string | null): string {
  const key = (id ?? "none").toLowerCase();
  return ACCELERATION_LABELS[key] ?? key;
}

export function accelerationShortLabel(id?: string | null): string {
  const key = (id ?? "none").toLowerCase();
  return ACCELERATION_SHORT[key] ?? key;
}

const CODEC_LABELS: Record<string, string> = {
  h264: "H.264",
  hevc: "HEVC",
  hevc10: "HEVC 10-bit",
  vp9: "VP9",
  vp910: "VP9 10-bit",
  av1: "AV1",
  mpeg2video: "MPEG-2",
  mpeg4: "MPEG-4",
  vc1: "VC-1",
  aac: "AAC",
  ac3: "AC-3",
  eac3: "E-AC-3",
  opus: "Opus",
  mp3: "MP3",
  flac: "FLAC",
  dts: "DTS",
  truehd: "TrueHD",
  vorbis: "Vorbis",
};

export function codecLabel(codec?: string | null): string {
  if (!codec) return "unknown";
  return CODEC_LABELS[codec.toLowerCase()] ?? codec.toUpperCase();
}

/** Coarse marketing resolution; width-based so letterboxed 1920×800 still reads as 1080p. */
export function resolutionLabel(width?: number | null, height?: number | null): string {
  const w = width ?? 0;
  const h = height ?? 0;
  if (w <= 0 && h <= 0) return "unknown";
  if (w >= 7000 || h >= 4000) return "8K";
  if (w >= 3200 || h >= 2000) return "4K";
  if (w >= 2400 || h >= 1400) return "1440p";
  if (w >= 1800 || h >= 1000) return "1080p";
  if (w >= 1200 || h >= 700) return "720p";
  return `${h}p`;
}

export function hdrLabel(hdr?: string | null): string {
  switch ((hdr ?? "none").toLowerCase()) {
    case "hdr10":
      return "HDR10";
    case "hlg":
      return "HLG";
    case "dolbyvision":
      return "Dolby Vision";
    default:
      return "SDR";
  }
}

export function isHdr(hdr?: string | null): boolean {
  return hdrLabel(hdr) !== "SDR";
}

export function channelLabel(channels?: number | null): string {
  if (!channels) return "";
  if (channels === 1) return "mono";
  if (channels === 2) return "stereo";
  if (channels === 6) return "5.1";
  if (channels === 8) return "7.1";
  return `${channels} ch`;
}

const TONE_MAP_TEXT: Record<string, string> = {
  hardware: "tone-mapped on the GPU",
  software: "tone-mapped on the CPU",
  disabled: "HDR not tone-mapped (disabled)",
  unavailable: "HDR not tone-mapped (unavailable)",
};

/** "HEVC 4K HDR10 → H.264 1080p SDR · VideoToolbox decode+encode · tone-mapped on the GPU". */
export function planSummary(plan: TranscodePlanResponse): string {
  const source = plan.source;
  const target = plan.target;
  const sourceHdr = isHdr(source.hdr);
  const toneMap = (plan.toneMap ?? "notneeded").toLowerCase();
  const tenBit = !sourceHdr && source.bitDepth > 8 ? " 10-bit" : "";
  const from = `${codecLabel(source.videoCodec)} ${resolutionLabel(source.width, source.height)}${tenBit} ${hdrLabel(source.hdr)}`;
  const outputRange = !sourceHdr || toneMap === "hardware" || toneMap === "software" ? " SDR" : "";
  const to = `${codecLabel(target.videoCodec)} ${resolutionLabel(target.width, target.height)}${outputRange}`;
  const parts = [`${from} → ${to}`, pipelineSummary(plan)];
  if (TONE_MAP_TEXT[toneMap]) parts.push(TONE_MAP_TEXT[toneMap]);
  if (plan.deinterlace) parts.push("deinterlaced");
  return parts.join(" · ");
}

export function pipelineSummary(plan: TranscodePlanResponse): string {
  const accel = accelerationShortLabel(plan.acceleration);
  if (plan.hardwareDecode && plan.hardwareEncode) return `${accel} decode+encode`;
  if (plan.hardwareDecode) return `${accel} decode · software encode`;
  if (plan.hardwareEncode) return `software decode · ${accel} encode`;
  return "software (CPU)";
}

export function audioSummary(plan: TranscodePlanResponse): string | null {
  const target = plan.target;
  if (target.audioStreamIndex == null && !target.audioSourceCodec) return null;
  const source = plan.source.audio?.find((track) => track.index === target.audioStreamIndex);
  const from = `${codecLabel(target.audioSourceCodec ?? source?.codec)}${source?.channels ? ` ${channelLabel(source.channels)}` : ""}`;
  if (target.audioCopy) return `${from} (copied)`;
  const to = `AAC ${channelLabel(target.audioChannels)}${target.audioBitrateKbps ? ` · ${target.audioBitrateKbps} kbps` : ""}`.trim();
  return `${from} → ${to}`;
}

export interface StatusMeta {
  label: string;
  tone: Tone;
}

const ACCELERATOR_STATUS: Record<string, StatusMeta> = {
  ready: { label: "Ready", tone: "success" },
  partial: { label: "Partial", tone: "warning" },
  failed: { label: "Failed", tone: "danger" },
  "no-device": { label: "No device", tone: "warning" },
  unavailable: { label: "Not in this ffmpeg", tone: "muted" },
  "not-applicable": { label: "Not on this platform", tone: "muted" },
};

export function acceleratorStatus(status?: string | null): StatusMeta {
  return ACCELERATOR_STATUS[(status ?? "").toLowerCase()] ?? { label: status ?? "unknown", tone: "muted" };
}

export function findAccelerator(
  caps: TranscodingCapabilitiesResponse | undefined,
  id?: string | null,
): AcceleratorResponse | undefined {
  return caps?.accelerators?.find((accelerator) => accelerator.id === id);
}

export interface HealthVerdict {
  tone: Tone | "pending";
  title: string;
  detail: string;
}

/** One-line operator verdict combining detection results and the configured backend. */
export function transcodingHealth(
  caps: TranscodingCapabilitiesResponse | undefined,
  config: TranscodingConfigResponse | undefined,
): HealthVerdict {
  if (!caps || !caps.detected) {
    return {
      tone: "pending",
      title: "Detecting ffmpeg and hardware…",
      detail: "Running ffmpeg, listing encoders and running tiny hardware encode/decode self-tests.",
    };
  }
  if (!caps.ffmpegFound) {
    return {
      tone: "danger",
      title: "ffmpeg missing",
      detail: caps.error ?? "ffmpeg could not be started. Install ffmpeg 5 or newer, or set Streamarr:Transcoding:FfmpegPath.",
    };
  }
  if (!caps.ffprobeFound) {
    return {
      tone: "danger",
      title: "ffprobe missing",
      detail: "ffprobe is required to inspect sources. Install it alongside ffmpeg or set Streamarr:Transcoding:FfprobePath.",
    };
  }
  if (!caps.meetsMinimumVersion) {
    return {
      tone: "danger",
      title: "ffmpeg is too old",
      detail: `ffmpeg ${caps.version ?? "(unknown version)"} was found; transcoding needs ffmpeg 5 or newer.`,
    };
  }
  if (!caps.usable) {
    return {
      tone: "danger",
      title: "ffmpeg cannot transcode",
      detail: caps.error ?? "This ffmpeg build lacks libx264 or the AAC encoder.",
    };
  }
  if (config && !config.enabled) {
    return {
      tone: "muted",
      title: "Transcoding disabled",
      detail: "ffmpeg works, but server transcoding is switched off in Settings.",
    };
  }
  const configured = (config?.acceleration ?? "none").toLowerCase();
  const recommended = (caps.recommended ?? "none").toLowerCase();
  if (configured !== "none") {
    const accelerator = findAccelerator(caps, configured);
    const status = (accelerator?.status ?? "").toLowerCase();
    const label = accelerationLabel(configured);
    if (status === "ready") {
      return {
        tone: "success",
        title: `Transcoding ready — hardware accelerated via ${label}`,
        detail: "Hardware encode and decode passed the self-tests on this machine.",
      };
    }
    if (status === "partial") {
      return {
        tone: "warning",
        title: `Transcoding ready — partially accelerated via ${label}`,
        detail: "Some hardware self-tests failed; affected steps run on the CPU.",
      };
    }
    return {
      tone: "warning",
      title: `Software fallback — ${label} is not working`,
      detail: `${label} is configured but ${acceleratorStatus(status).label.toLowerCase()}; every transcode runs on the CPU.`,
    };
  }
  if (recommended !== "none") {
    return {
      tone: "warning",
      title: "Software only — hardware acceleration available",
      detail: `${accelerationLabel(recommended)} passed the self-tests but is not enabled.`,
    };
  }
  return {
    tone: "info",
    title: "Transcoding ready — software (CPU) only",
    detail: "No hardware encoder passed the self-tests; ffmpeg transcodes on the CPU.",
  };
}

const BENCHMARK_STATES: Record<string, string> = {
  queued: "Queued",
  preparingsample: "Generating sample",
  running: "Transcoding",
  completed: "Completed",
  failed: "Failed",
};

export function benchmarkStateLabel(state?: string | null): string {
  const key = (state ?? "").toLowerCase().replace(/[^a-z]/g, "");
  return BENCHMARK_STATES[key] ?? state ?? "unknown";
}

const VERDICTS: Record<string, StatusMeta> = {
  excellent: { label: "Excellent", tone: "success" },
  good: { label: "Good", tone: "success" },
  marginal: { label: "Marginal", tone: "warning" },
  "too-slow": { label: "Too slow", tone: "danger" },
  failed: { label: "Failed", tone: "danger" },
};

export function verdictMeta(verdict?: string | null): StatusMeta {
  return VERDICTS[(verdict ?? "").toLowerCase()] ?? { label: verdict ?? "unknown", tone: "muted" };
}

export function sampleStateMeta(state?: string | null): StatusMeta {
  switch ((state ?? "").toLowerCase()) {
    case "ready":
      return { label: "Ready", tone: "success" };
    case "generating":
      return { label: "Generating", tone: "info" };
    case "failed":
      return { label: "Failed", tone: "danger" };
    case "unsupported":
      return { label: "Unsupported", tone: "muted" };
    default:
      return { label: "Not generated", tone: "muted" };
  }
}

export function jobStateMeta(job?: TranscodeJobResponse | null): StatusMeta {
  if (!job) return { label: "Idle (no ffmpeg)", tone: "muted" };
  if (job.running && job.paused) return { label: "Paused (throttled)", tone: "info" };
  if (job.running) return { label: "Running", tone: "success" };
  if (job.exitCode === 0) return { label: "Finished", tone: "muted" };
  if (job.stoppedByServer) return { label: "Stopped (player idle)", tone: "muted" };
  return { label: `Exited (code ${job.exitCode ?? "?"})`, tone: "warning" };
}

export function formatBitrate(kbps?: number | null): string {
  if (kbps == null || !Number.isFinite(kbps)) return "—";
  if (kbps >= 1_000) return `${(kbps / 1_000).toFixed(kbps >= 10_000 ? 0 : 1)} Mbps`;
  return `${Math.round(kbps)} kbps`;
}

export function formatSpeed(speed?: number | null): string {
  if (speed == null || !Number.isFinite(speed)) return "—";
  return `${speed.toFixed(speed >= 10 ? 0 : speed >= 1 ? 1 : 2)}×`;
}

/** Output height caps offered by the benchmark runner and test players; 4320 means "keep source". */
export const HEIGHT_OPTIONS: { value: number; label: string }[] = [
  { value: 4320, label: "Source" },
  { value: 2160, label: "2160p (4K)" },
  { value: 1080, label: "1080p" },
  { value: 720, label: "720p" },
  { value: 480, label: "480p" },
];

/** Quote an argv for display so it can be pasted into a POSIX shell. */
export function shellCommand(args: readonly string[], program = "ffmpeg"): string {
  const quote = (value: string) => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`);
  return [program, ...args.map(quote)].join(" ");
}

export function deviceCheck(device: GpuDeviceResponse, backend: string) {
  return (device.checks ?? []).find((check) => check.backend === backend);
}

/** "✓ renderD129 — Intel (i915 · 00:02.0)": the test result leads so it survives truncation on phones. */
export function deviceOptionLabel(device: GpuDeviceResponse, backend: string): string {
  const check = deviceCheck(device, backend);
  const result = check?.passed === true ? "✓ " : check?.passed === false ? "✗ " : "";
  const unusable = device.kind === "drm" && device.driver === "nvidia" ? " · NVIDIA driver, no VA-API" : "";
  return `${result}${device.label ?? device.id}${unusable}`;
}

/** The backends a device can serve, in the order Overview offers them. */
export function deviceBackends(device: GpuDeviceResponse): string[] {
  if (device.kind === "cuda") return ["nvenc"];
  if (device.driver === "nvidia") return [];
  return device.vendorId === "0x8086" ? ["vaapi", "qsv"] : ["vaapi"];
}
