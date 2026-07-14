import { describe, expect, it } from "vitest";
import { safeRedirectTarget } from "./router";

describe("safeRedirectTarget", () => {
  it("keeps internal paths with query strings and fragments", () => {
    expect(safeRedirectTarget("/playback?releaseId=abc#player")).toBe(
      "/playback?releaseId=abc#player",
    );
  });

  it.each([
    "https://attacker.example/",
    "//attacker.example/",
    "/\\attacker.example/",
    "javascript:alert(1)",
    "relative/path",
    "x".repeat(2_049),
  ])("rejects an unsafe return target: %s", (target) => {
    expect(safeRedirectTarget(target)).toBeUndefined();
  });
});
