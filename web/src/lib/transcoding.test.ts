import { describe, expect, it } from "vitest";
import { isBenchmarkActive, transcodeCapabilityUrl } from "@/api/queries";
import { capabilities, config, plan, remuxPlan, vaapiNoDevice, videoToolboxReady } from "@/test/transcoding-fixtures";
import {
  audioSummary,
  formatBitrate,
  formatSpeed,
  modeMeta,
  planSummary,
  shellCommand,
  transcodingHealth,
} from "./transcoding";

describe("transcodingHealth", () => {
  it("is pending until the first detection finishes", () => {
    expect(transcodingHealth(capabilities({ detected: false, detecting: true }), config()).tone).toBe("pending");
  });

  it("reports hardware acceleration when the configured backend passed its self-tests", () => {
    const verdict = transcodingHealth(capabilities(), config());
    expect(verdict.tone).toBe("success");
    expect(verdict.title).toContain("Apple VideoToolbox");
  });

  it("warns that a configured backend without a device silently falls back to software", () => {
    const verdict = transcodingHealth(
      capabilities({ accelerators: [videoToolboxReady, vaapiNoDevice] }),
      config({ acceleration: "vaapi" }),
    );
    expect(verdict.tone).toBe("warning");
    expect(verdict.title).toMatch(/software fallback/i);
  });

  it("points out an unused working accelerator", () => {
    const verdict = transcodingHealth(capabilities(), config({ acceleration: "none" }));
    expect(verdict.tone).toBe("warning");
    expect(verdict.title).toMatch(/hardware acceleration available/i);
  });

  it("is a hard failure without ffmpeg, and muted when disabled", () => {
    expect(transcodingHealth(capabilities({ ffmpegFound: false, usable: false, version: null }), config()).tone).toBe("danger");
    expect(transcodingHealth(capabilities(), config({ enabled: false })).tone).toBe("muted");
  });
});

describe("plan summaries", () => {
  it("describes the conversion and the pipeline in one line", () => {
    expect(planSummary(plan())).toBe("H.264 1080p SDR → H.264 720p SDR · VideoToolbox decode+encode");
  });

  it("names HDR tone mapping and software pipelines", () => {
    const hdr = plan({
      source: { ...plan().source, videoCodec: "hevc", width: 3840, height: 2160, bitDepth: 10, hdr: "hdr10" },
      hardwareDecode: false,
      hardwareEncode: false,
      acceleration: "none",
      toneMap: "software",
    });
    expect(planSummary(hdr)).toBe("HEVC 4K HDR10 → H.264 720p SDR · software (CPU) · tone-mapped on the CPU");
  });

  it("explains audio conversion", () => {
    expect(audioSummary(plan())).toBe("AC-3 5.1 → AAC stereo · 192 kbps");
    expect(audioSummary(remuxPlan())).toBe("TrueHD 5.1 → E-AC-3 5.1 · 640 kbps");
  });

  it("summarises stream copies and direct play without an encoder pipeline", () => {
    expect(planSummary(remuxPlan())).toBe("HEVC 4K HDR10 · stream copy (remux) · audio TrueHD 5.1 → E-AC-3 5.1 · 640 kbps");
    const copiedAudio = remuxPlan({ target: { ...remuxPlan().target, audioCopy: true, audioCodec: "truehd" } });
    expect(planSummary(copiedAudio)).toBe("HEVC 4K HDR10 · stream copy (remux)");
    expect(planSummary(plan({ mode: "direct" }))).toBe("H.264 1080p SDR · direct play");
  });

  it("labels delivery modes", () => {
    expect(modeMeta("remux")).toMatchObject({ label: "Remux", tone: "info" });
    expect(modeMeta("direct").label).toBe("Direct play");
    expect(modeMeta(null).label).toBe("Transcode");
  });
});

describe("formatting", () => {
  it("formats speed and bitrate for humans", () => {
    expect(formatSpeed(11.24)).toBe("11×");
    expect(formatSpeed(1.26)).toBe("1.3×");
    expect(formatSpeed(0.84)).toBe("0.84×");
    expect(formatBitrate(4109)).toBe("4.1 Mbps");
    expect(formatBitrate(640)).toBe("640 kbps");
  });

  it("quotes ffmpeg arguments so the command can be pasted into a shell", () => {
    expect(shellCommand(["-vf", "scale=w=1280:h=720,format=yuv420p", "-force_key_frames:v", "expr:gte(t,n_forced*4)"])).toBe(
      "ffmpeg -vf scale=w=1280:h=720,format=yuv420p -force_key_frames:v 'expr:gte(t,n_forced*4)'",
    );
  });
});

describe("transcode helpers", () => {
  it("derives the capability root from a playlist URL", () => {
    expect(transcodeCapabilityUrl("/api/v1/transcode/abc_-1/master.m3u8")).toBe("/api/v1/transcode/abc_-1");
    expect(transcodeCapabilityUrl("/api/v1/stream/abc")).toBeNull();
  });

  it("treats queued, preparing and running benchmarks as active", () => {
    expect(isBenchmarkActive("preparing-sample")).toBe(true);
    expect(isBenchmarkActive("running")).toBe(true);
    expect(isBenchmarkActive("completed")).toBe(false);
    expect(isBenchmarkActive("failed")).toBe(false);
  });
});
