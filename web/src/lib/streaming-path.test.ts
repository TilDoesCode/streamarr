import { describe, expect, it } from "vitest";
import {
  BROWSER_RESULT_KEY,
  loadBrowserResult,
  playbackCapability,
  saveBrowserResult,
  STREAMING_PATH_HEADROOM,
  streamingPathVerdict,
  tierThreshold,
  usenetProviderLabel,
} from "./streaming-path";

describe("playbackCapability", () => {
  it("uses typical bitrates × 1.3 headroom as thresholds", () => {
    expect(STREAMING_PATH_HEADROOM).toBe(1.3);
    expect([80, 25, 10, 5].map(tierThreshold)).toEqual([104, 32.5, 13, 6.5]);
  });

  it.each([
    [500, "everything plays, including 4K remuxes"],
    [104, "everything plays, including 4K remuxes"],
    [103.9, "4K WEB and 1080p play smoothly; 4K remuxes (~80 Mbit/s) will buffer"],
    [32.5, "4K WEB and 1080p play smoothly; 4K remuxes (~80 Mbit/s) will buffer"],
    [32.4, "1080p plays; 4K will buffer"],
    [13, "1080p plays; 4K will buffer"],
    [12.9, "only 720p plays smoothly; 1080p and 4K will buffer"],
    [6.5, "only 720p plays smoothly; 1080p and 4K will buffer"],
    [6.4, "too slow even for 720p"],
    [0, "too slow even for 720p"],
  ])("%s Mbit/s → %s", (mbps, text) => {
    expect(playbackCapability(mbps)).toBe(text);
  });
});

describe("streamingPathVerdict", () => {
  it("names the slower leg as the bottleneck", () => {
    const browser = streamingPathVerdict(250, 38);
    expect(browser).toMatchObject({ limitMbps: 38, bottleneck: "browser", missing: [] });
    expect(browser.text).toBe(
      "This browser is the bottleneck: ~38 Mbit/s → 4K WEB and 1080p play smoothly; 4K remuxes (~80 Mbit/s) will buffer.",
    );
    const usenet = streamingPathVerdict(25, 300);
    expect(usenet.bottleneck).toBe("usenet");
    expect(usenet.text).toBe("Usenet is the bottleneck: ~25 Mbit/s → 1080p plays; 4K will buffer.");
  });

  it("says which leg is missing", () => {
    expect(streamingPathVerdict(120, null)).toMatchObject({ missing: ["browser"], bottleneck: null, limitMbps: 120 });
    expect(streamingPathVerdict(120, null).text).toMatch(/Server → This browser is not measured yet/);
    expect(streamingPathVerdict(undefined, 5).text).toMatch(/Usenet → Server is not measured yet/);
    expect(streamingPathVerdict(null, null)).toMatchObject({ limitMbps: null, missing: ["usenet", "browser"] });
  });
});

describe("browser result storage", () => {
  it("round-trips and ignores malformed values", () => {
    localStorage.removeItem(BROWSER_RESULT_KEY);
    expect(loadBrowserResult()).toBeNull();
    saveBrowserResult({ downloadMbps: 38.2, uploadMbps: 12, pingMs: 4, measuredAt: "2026-10-26T10:00:00Z" });
    expect(loadBrowserResult()).toEqual({ downloadMbps: 38.2, uploadMbps: 12, pingMs: 4, measuredAt: "2026-10-26T10:00:00Z" });
    localStorage.setItem(BROWSER_RESULT_KEY, "{not json");
    expect(loadBrowserResult()).toBeNull();
    localStorage.removeItem(BROWSER_RESULT_KEY);
  });
});

describe("usenetProviderLabel", () => {
  it("labels primary and backups, with the name when present", () => {
    expect(usenetProviderLabel({ index: 1, role: "primary", name: "Newshosting" })).toBe("Primary · Newshosting");
    expect(usenetProviderLabel({ index: 2, role: "backup", name: "Eweka" })).toBe("Backup #2 · Eweka");
    expect(usenetProviderLabel({ index: 3, role: "backup" })).toBe("Backup #3");
  });
});
