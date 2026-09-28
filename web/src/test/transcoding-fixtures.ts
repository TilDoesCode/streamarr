import type {
  AcceleratorResponse,
  GpuDeviceResponse,
  BenchmarkResponse,
  TranscodePlanResponse,
  TranscodeSessionCreatedResponse,
  TranscodeSessionResponse,
  TranscodingCapabilitiesResponse,
  TranscodingConfigResponse,
  TranscodingSampleResponse,
} from "../api/types";

const CODECS = ["h264", "hevc", "hevc10", "vp9", "vp910", "av1", "mpeg2video", "vc1"];

function accelerator(
  id: string,
  label: string,
  status: string,
  overrides: Partial<AcceleratorResponse> = {},
  decodePassed: Record<string, boolean | null> = {},
): AcceleratorResponse {
  return {
    id,
    label,
    status,
    platformSupported: status !== "not-applicable",
    compiledIn: status !== "not-applicable",
    devicePresent: null,
    device: null,
    h264Encode: { passed: null, detail: null },
    hevcEncode: { passed: null, detail: null },
    toneMapping: { passed: null, detail: null },
    decode: CODECS.map((codec) => ({ codec, passed: decodePassed[codec] ?? null, detail: null })),
    notes: [],
    ...overrides,
  };
}

export const videoToolboxReady = accelerator(
  "videotoolbox",
  "Apple VideoToolbox",
  "ready",
  {
    h264Encode: { passed: true, detail: "207 ms" },
    hevcEncode: { passed: true, detail: "236 ms" },
    toneMapping: { passed: true, detail: "312 ms" },
  },
  { h264: true, hevc: true, hevc10: true, vp9: true, vp910: true, av1: false, mpeg2video: false, vc1: false },
);

export const vaapiNoDevice = accelerator("vaapi", "VA-API (Intel / AMD)", "no-device", {
  platformSupported: true,
  compiledIn: true,
  devicePresent: false,
  device: "/dev/dri/renderD128",
  notes: ["/dev/dri/renderD128 does not exist. Pass the GPU into the container with --device /dev/dri."],
});

export function capabilities(overrides: Partial<TranscodingCapabilitiesResponse> = {}): TranscodingCapabilitiesResponse {
  return {
    detecting: false,
    detected: true,
    detectedAt: new Date(Date.now() - 60_000).toISOString(),
    durationSeconds: 2.69,
    ffmpegFound: true,
    ffmpegPath: "ffmpeg",
    version: "7.1.1",
    majorVersion: 7,
    meetsMinimumVersion: true,
    ffprobeFound: true,
    ffprobeVersion: "7.1.1",
    error: null,
    usable: true,
    softwareToneMapping: true,
    relativeKeyframeExpressions: true,
    recommended: "videotoolbox",
    platform: { os: "macOS", architecture: "arm64", inContainer: false, cpuModel: "Apple M2", logicalCores: 8 },
    accelerators: [
      videoToolboxReady,
      vaapiNoDevice,
      accelerator("qsv", "Intel Quick Sync (QSV)", "not-applicable", { notes: ["Intel Quick Sync (QSV) is not available on macOS."] }),
      accelerator("nvenc", "NVIDIA NVENC / NVDEC", "not-applicable"),
    ],
    videoEncoders: ["h264_videotoolbox", "hevc_videotoolbox", "libx264", "libx265"],
    audioEncoders: ["aac", "ac3", "libopus"],
    hwAccels: ["videotoolbox"],
    filters: ["scale", "scale_vt", "zscale", "tonemap", "bwdif"],
    ...overrides,
  };
}

export function config(overrides: Partial<TranscodingConfigResponse> = {}): TranscodingConfigResponse {
  return {
    enabled: true,
    acceleration: "videotoolbox",
    vaapiDevice: "/dev/dri/renderD128",
    nvencDevice: 0,
    hardwareDecoding: true,
    hardwareDecodingAuto: true,
    hardwareDecodingCodecs: ["h264", "hevc", "hevc10", "vp9", "vp910"],
    hardwareEncoding: true,
    toneMapping: true,
    allowHevcOutput: false,
    encoderPreset: "veryfast",
    crf: 23,
    maxBitrateKbps: 20_000,
    maxHeight: 2160,
    audioBitrateKbps: 192,
    allowSurroundAudio: false,
    segmentLengthSeconds: 4,
    throttleEnabled: true,
    throttleBufferSeconds: 120,
    maxConcurrentTranscodes: 2,
    jobIdleTimeoutSeconds: 60,
    sessionIdleTimeoutSeconds: 1_800,
    segmentRetentionSeconds: 900,
    threads: 0,
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    workspacePath: "/app/data/transcode",
    samplesPath: "/app/data/transcoding-samples",
    workspaceBytes: 48_234_496,
    throttleSupported: true,
    accelerations: ["none", "videotoolbox", "vaapi", "qsv", "nvenc"],
    encoderPresets: ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow"],
    decodeCodecs: CODECS,
    ...overrides,
  };
}

export const samples: TranscodingSampleResponse[] = [
  {
    id: "h264-1080p-ac3",
    title: "1080p H.264 · Dolby Digital 5.1",
    description: "The most common Usenet WEB-DL shape. Browsers cannot play AC-3 or MKV reliably, so this needs the server.",
    video: "H.264 High · 1920×1080 · 23.976 fps · 8-bit SDR · ~6 Mbps",
    audio: "AC-3 5.1 · 384 kbps",
    durationSeconds: 30,
    state: "ready",
    progress: 1,
    sizeBytes: 24_080_810,
    error: null,
  },
  {
    id: "hevc-2160p-hdr10",
    title: "4K HEVC HDR10 · E-AC-3 5.1",
    description: "The worst case: 4K 10-bit decode, downscaling and HDR→SDR tone mapping in one pipeline.",
    video: "HEVC Main10 · 3840×2160 · 23.976 fps · HDR10 (PQ, BT.2020) · ~12 Mbps",
    audio: "E-AC-3 5.1 · 640 kbps",
    durationSeconds: 12,
    state: "generating",
    progress: 0.42,
    sizeBytes: null,
    error: null,
  },
  {
    id: "av1-1080p-opus",
    title: "1080p AV1 10-bit · Opus 5.1",
    description: "Modern AV1 release. Only GPUs from ~2021 decode AV1 in hardware.",
    video: "AV1 Main · 1920×1080 · 24 fps · 10-bit SDR · ~3 Mbps",
    audio: "Opus 5.1 · 256 kbps",
    durationSeconds: 20,
    state: "missing",
    progress: 0,
    sizeBytes: null,
    error: null,
  },
];

export function plan(overrides: Partial<TranscodePlanResponse> = {}): TranscodePlanResponse {
  return {
    directPlayPossible: false,
    directPlayBlockers: [
      "Container 'mkv' is not supported by the player.",
      "Audio codec 'ac3' is not supported by the player.",
    ],
    source: {
      container: "mkv",
      durationSeconds: 30,
      bitrateKbps: 6421,
      videoCodec: "h264",
      videoProfile: "High",
      width: 1920,
      height: 1080,
      bitDepth: 8,
      frameRate: 23.976,
      hdr: "none",
      interlaced: false,
      audio: [{ index: 1, codec: "ac3", channels: 6, language: "eng", title: null, isDefault: true }],
    },
    target: {
      videoCodec: "h264",
      width: 1280,
      height: 720,
      videoBitrateKbps: 4109,
      frameRate: 23.976,
      level: "4.1",
      codecs: "avc1.640029,mp4a.40.2",
      audioStreamIndex: 1,
      audioSourceCodec: "ac3",
      audioCopy: false,
      audioChannels: 2,
      audioBitrateKbps: 192,
    },
    acceleration: "videotoolbox",
    accelerationLabel: "Apple VideoToolbox",
    hardwareDecode: true,
    hardwareDecodeReason: "Apple VideoToolbox decodes 'h264'.",
    hardwareEncode: true,
    hardwareEncodeReason: "h264_videotoolbox passed the self-test.",
    encoder: "h264_videotoolbox",
    toneMap: "notneeded",
    deinterlace: false,
    videoFilters: "scale_vt=w=1280:h=720",
    warnings: [],
    ...overrides,
  };
}

export function benchmark(overrides: Partial<BenchmarkResponse> = {}): BenchmarkResponse {
  const checks = Array.from({ length: 8 }, (_, index) => ({
    index,
    startSeconds: index * 4,
    durationSeconds: index === 7 ? 2 : 4,
    startsWithKeyframe: true,
    driftMs: index === 0 ? 0 : 0.4,
  }));
  return {
    id: "b3f1c2d4e5f6",
    sampleId: "h264-1080p-ac3",
    sampleTitle: "1080p H.264 · Dolby Digital 5.1",
    maxHeight: 1080,
    bitrateKbps: 8_000,
    acceleration: "videotoolbox",
    state: "completed",
    progress: 1,
    createdAt: new Date(Date.now() - 45_000).toISOString(),
    startedAt: new Date(Date.now() - 44_000).toISOString(),
    finishedAt: new Date(Date.now() - 40_000).toISOString(),
    error: null,
    activeTranscodesAtStart: 0,
    plan: plan({ target: { ...plan().target, width: 1920, height: 1080, videoBitrateKbps: 7_808 }, videoFilters: "" }),
    result: {
      verdict: "excellent",
      summary: "11.2× realtime — roughly 8 streams like this at once.",
      mediaSeconds: 30,
      wallSeconds: 2.68,
      speed: 11.2,
      fps: 268,
      cpuSeconds: 3.04,
      averageCpuCores: 1.13,
      cpuSharePercent: 14.1,
      timeToFirstSegmentMs: 412,
      seekTimeToFirstSegmentMs: 388,
      segments: 8,
      expectedSegments: 8,
      keyframesAligned: true,
      maxDriftMs: 0.4,
      outputBitrateKbps: 6_104,
      outputWidth: 1920,
      outputHeight: 1080,
      hardwareFallbackDetected: false,
      segmentChecks: checks,
      warnings: [],
      command: [
        "-hide_banner", "-hwaccel", "videotoolbox", "-i", "/app/data/transcoding-samples/h264-1080p-ac3.mkv",
        "-c:v", "h264_videotoolbox", "-b:v", "7808k", "-f", "hls", "-hls_time", "4", "job-1.m3u8",
      ],
      log: null,
    },
    ...overrides,
  };
}

export function createdSession(overrides: Partial<TranscodeSessionCreatedResponse> = {}): TranscodeSessionCreatedResponse {
  return {
    handle: "a53f5b44829f",
    playlistUrl: "/api/v1/transcode/cap-token-123/master.m3u8",
    mediaPlaylistUrl: "/api/v1/transcode/cap-token-123/main.m3u8",
    durationSeconds: 30,
    segmentLengthSeconds: 4,
    segmentCount: 8,
    plan: plan(),
    ...overrides,
  };
}

export function liveSession(overrides: Partial<TranscodeSessionResponse> = {}): TranscodeSessionResponse {
  return {
    handle: "a53f5b44829f",
    title: "Example.Movie.2021.1080p.WEB-DL.x264",
    client: "web playback preview",
    sourceKind: "stream",
    createdAt: new Date(Date.now() - 95_000).toISOString(),
    lastAccessAt: new Date(Date.now() - 2_000).toISOString(),
    segmentCount: 1_805,
    segmentLengthSeconds: 4,
    lastRequestedSegment: 312,
    segmentsServed: 44,
    bytesServed: 91_234_567,
    restarts: 1,
    timeToFirstSegmentMs: 640,
    startup: {
      capabilitiesMs: 0,
      probeMs: 48,
      probeCached: false,
      planMs: 2.9,
      spawnMs: 21,
      firstSegmentReadyMs: 612,
      firstSegmentServedMs: 640,
    },
    lastError: null,
    job: {
      startSegment: 300,
      front: 331,
      running: true,
      paused: false,
      fps: 188.4,
      speed: 7.9,
      frames: 2_980,
      cpuSeconds: 21.4,
      exitCode: null,
      stoppedByServer: false,
      startedAt: new Date(Date.now() - 20_000).toISOString(),
      timeToFirstSegmentMs: 612,
      log: [],
      command: ["-hide_banner", "-ss", "1200", "-i", "http://127.0.0.1:8080/api/v1/stream/{capability}", "-c:v", "h264_videotoolbox"],
    },
    plan: plan(),
    ...overrides,
  };
}

/** A Linux box with an NVIDIA dGPU enumerated first (renderD128), the Intel iGPU second, and two CUDA GPUs. */
export function multiGpuCapabilities(): TranscodingCapabilitiesResponse {
  const drm = (id: string, vendor: string, vendorId: string, driver: string, slot: string, checks: GpuDeviceResponse["checks"]) => ({
    id,
    kind: "drm",
    label: `${id.split("/").pop()} — ${vendor} (${driver} · ${slot})`,
    vendor,
    vendorId,
    driver,
    pciSlot: slot,
    checks,
  });
  return capabilities({
    recommended: "nvenc",
    platform: { os: "Linux", architecture: "x64", inContainer: true, cpuModel: "Intel(R) Core(TM) i5-12400", logicalCores: 12 },
    accelerators: [
      accelerator("videotoolbox", "Apple VideoToolbox", "not-applicable"),
      accelerator("vaapi", "VA-API (Intel / AMD)", "failed", {
        platformSupported: true,
        compiledIn: true,
        devicePresent: true,
        device: "/dev/dri/renderD128",
        h264Encode: { passed: false, detail: "Failed to initialise VAAPI connection: -1 (unknown libva error)." },
        notes: [
          "renderD128 — NVIDIA (nvidia · 01:00.0) belongs to the NVIDIA driver, which has no VA-API support. Use NVENC for this GPU, or pick another render node.",
          "renderD129 — Intel (i915 · 00:02.0) passes the VA-API (Intel / AMD) encode test — select it as the device in Settings.",
        ],
        alternativeDevice: "/dev/dri/renderD129",
      }),
      accelerator("qsv", "Intel Quick Sync (QSV)", "unavailable", { notes: ["This ffmpeg build has no QSV encoders."] }),
      accelerator("nvenc", "NVIDIA NVENC / NVDEC", "ready", {
        platformSupported: true,
        compiledIn: true,
        devicePresent: true,
        device: "cuda:0",
        h264Encode: { passed: true, detail: "142 ms" },
        hevcEncode: { passed: true, detail: "158 ms" },
      }, { h264: true, hevc: true, hevc10: true }),
    ],
    devices: [
      drm("/dev/dri/renderD128", "NVIDIA", "0x10de", "nvidia", "01:00.0", [{ backend: "vaapi", passed: false, detail: "Failed to initialise VAAPI connection" }]),
      drm("/dev/dri/renderD129", "Intel", "0x8086", "i915", "00:02.0", [{ backend: "vaapi", passed: true, detail: "96 ms" }]),
      { id: "cuda:0", kind: "cuda", label: "GPU 0 — NVIDIA GeForce RTX 3060 (NVIDIA · nvidia · 01:00.0)", name: "NVIDIA GeForce RTX 3060", vendor: "NVIDIA", driver: "nvidia", pciSlot: "01:00.0", index: 0, checks: [{ backend: "nvenc", passed: true, detail: "142 ms" }] },
      { id: "cuda:1", kind: "cuda", label: "GPU 1 — NVIDIA T400 (NVIDIA · nvidia · 05:00.0)", name: "NVIDIA T400", vendor: "NVIDIA", driver: "nvidia", pciSlot: "05:00.0", index: 1, checks: [{ backend: "nvenc", passed: true, detail: "121 ms" }] },
    ],
    videoEncoders: ["h264_nvenc", "h264_vaapi", "hevc_nvenc", "hevc_vaapi", "libx264", "libx265"],
    hwAccels: ["cuda", "vaapi"],
  });
}
