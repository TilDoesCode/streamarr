import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as configFixture, multiGpuCapabilities } from "../src/test/transcoding-fixtures";

// Drives the REAL server with the REAL ffmpeg: detection, sample generation, a benchmark, an hls.js
// test player and a direct-play → server-transcode switch in Playback Preview. Nothing is stubbed.

const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "streamarr-e2e";
const RELEASE_TITLE = "Example.Movie.2021.1080p.WEB-DL.x264-STREAMARR";
const CAPTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../test-results/transcoding-ui");

async function login(page: Page) {
  await page.addInitScript(() => {
    if (!localStorage.getItem("streamarr.theme")) localStorage.setItem("streamarr.theme", "light");
  });
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("link", { name: "Transcoding" })).toBeVisible();
}

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({
    content: "*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important}",
  });
}

async function setTheme(page: Page, theme: "light" | "dark") {
  const isDark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
  if ((theme === "dark") !== isDark) {
    await page.getByRole("button", { name: theme === "dark" ? "Switch to dark mode" : "Switch to light mode" }).first().click();
  }
}

// A viewport as tall as the document keeps the sticky shell and save bar where a user sees them.
async function capture(page: Page, name: string) {
  const viewport = page.viewportSize()!;
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: viewport.width, height: Math.min(Math.max(height, viewport.height), 4_000) });
  await settle(page);
  await page.screenshot({ path: path.join(CAPTURE_DIR, name), animations: "disabled", caret: "hide" });
  await page.setViewportSize(viewport);
}

async function expectVideoPlays(page: Page, label: string) {
  const video = page.getByLabel(label, { exact: true });
  await expect(video).toBeVisible();
  await video.evaluate((el: HTMLVideoElement) => {
    el.muted = true;
    void el.play().catch(() => undefined);
  });
  await expect
    .poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime), {
      timeout: 60_000,
      message: `${label}: currentTime never advanced`,
    })
    .toBeGreaterThan(1);
  return video;
}

test.describe.configure({ mode: "serial" });

test("detects ffmpeg, benchmarks a sample and plays transcoded HLS in the test lab", async ({ page }) => {
  test.setTimeout(300_000);
  await mkdir(CAPTURE_DIR, { recursive: true });
  await login(page);
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.getByRole("link", { name: "Transcoding" }).click();
  await expect(page).toHaveURL(/\/transcoding/);
  await expect(page.getByRole("button", { name: /re-run hardware detection/i })).toBeEnabled({ timeout: 90_000 });
  await expect(page.getByRole("heading", { name: /ffmpeg/i }).first()).toBeVisible();
  await expect(page.getByText(/libx264/).first()).toBeVisible();
  await capture(page, "overview-desktop-light.png");

  // A host with a working GPU backend gets a one-click recommendation; CI without one stays on software.
  const recommendation = page.getByRole("note", { name: "Recommended acceleration" });
  if (await recommendation.isVisible()) {
    await recommendation.getByRole("button").click();
    await expect(recommendation).toBeHidden({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: /re-run hardware detection/i })).toBeEnabled({ timeout: 90_000 });
  }
  await setTheme(page, "dark");
  await capture(page, "overview-desktop-dark.png");

  await page.getByRole("tab", { name: "Test lab" }).click();
  await expect(page).toHaveURL(/tab=lab/);
  await page.getByLabel("Sample", { exact: true }).selectOption("h264-1080p-ac3");
  await page.getByLabel("Max height").first().selectOption("720");
  await page.getByRole("button", { name: /run benchmark/i }).click();
  const result = page.getByRole("article", { name: "Benchmark result" });
  await expect(result.getByText(/realtime/).first()).toBeVisible({ timeout: 180_000 });
  await expect(result.getByText(/Excellent|Good|Marginal|Too slow/).first()).toBeVisible();
  await result.scrollIntoViewIfNeeded();
  await capture(page, "test-lab-benchmark-desktop-dark.png");

  await setTheme(page, "light");
  await page.getByLabel("Ready sample").selectOption("h264-1080p-ac3");
  await page.getByRole("button", { name: /start transcode/i }).click();
  const video = await expectVideoPlays(page, "Transcoding test player");
  expect(await video.evaluate((el: HTMLVideoElement) => el.videoHeight)).toBe(720);
  await video.evaluate((el: HTMLVideoElement) => el.pause());
  await video.scrollIntoViewIfNeeded();
  await capture(page, "test-player-desktop-light.png");

  await page.getByRole("tab", { name: /Sessions/ }).click();
  const sessions = page.getByRole("list", { name: "Live transcode sessions" });
  await expect(sessions.getByText("web test player").first()).toBeVisible();
  await expect(sessions).not.toContainText("/api/v1/transcode/");
  await capture(page, "sessions-desktop-light.png");

  await page.getByRole("tab", { name: "Settings" }).click();
  await expect(page.getByRole("form", { name: "Transcoding settings" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, "settings-mobile-light.png");
  await setTheme(page, "dark");
  await capture(page, "settings-mobile-dark.png");
});

test("switches Playback Preview from direct play to the server transcoder and back", async ({ page }) => {
  test.setTimeout(180_000);
  await login(page);
  await page.setViewportSize({ width: 1440, height: 1000 });

  const release = await page.evaluate(async (title) => {
    const indexers = (await (await fetch("/api/v1/config/indexers")).json()) as unknown[];
    if (indexers.length === 0) {
      const created = await fetch("/api/v1/config/indexers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "mock", baseUrl: "https://mock.example", apiKey: "mock-key", categories: [2000, 5000] }),
      });
      if (!created.ok) throw new Error(`Could not add the fixture indexer (${created.status})`);
    }
    const response = await fetch("/api/v1/search?q=Example%20Movie");
    if (!response.ok) throw new Error(`Search failed (${response.status})`);
    const body = (await response.json()) as { results: { workId: string; releases: { releaseId: string; title: string }[] }[] };
    for (const work of body.results) {
      const match = work.releases.find((r) => r.title === title);
      if (match) return { releaseId: match.releaseId, workId: work.workId };
    }
    return null;
  }, RELEASE_TITLE);
  expect(release, "the canned release is searchable").not.toBeNull();

  await page.goto(`/playback?releaseId=${encodeURIComponent(release!.releaseId)}&workId=${encodeURIComponent(release!.workId)}`);
  const direct = page.getByRole("radio", { name: /direct play/i });
  await expect(direct).toHaveAttribute("aria-checked", "true", { timeout: 60_000 });
  await expect(page.locator("video")).toHaveAttribute("src", /^\/api\/v1\/stream\//);

  await page.getByRole("radio", { name: /server transcode/i }).click();
  await expectVideoPlays(page, "Transcoded preview");
  await expect(page.getByText(/VP8 .* → H\.264/).first()).toBeVisible();
  await capture(page, "playback-transcode-desktop-light.png");

  await direct.click();
  await expect(page.locator("video")).toHaveAttribute("src", /^\/api\/v1\/stream\//);
  await expect
    .poll(async () => page.evaluate(async () => ((await (await fetch("/api/v1/transcoding/sessions")).json()) as unknown[]).length), {
      timeout: 15_000,
    })
    .toBe(0);
});

test("shows every GPU of a multi-GPU host and which one transcodes", async ({ page }) => {
  await mkdir(CAPTURE_DIR, { recursive: true });
  const fulfill = (body: unknown) => async (route: import("@playwright/test").Route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  };
  await page.route("**/api/v1/transcoding/capabilities", fulfill(multiGpuCapabilities()));
  await page.route("**/api/v1/transcoding/config", fulfill(configFixture({ acceleration: "vaapi", vaapiDevice: "/dev/dri/renderD128" })));
  await login(page);
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.goto("/transcoding");
  const devices = page.getByRole("list", { name: "Graphics devices" });
  await expect(devices.getByText("NVIDIA GeForce RTX 3060")).toBeVisible();
  const hints = page.getByRole("note", { name: /VA-API \(Intel \/ AMD\) setup hints/ });
  await expect(hints.getByRole("button", { name: /use renderD129/i })).toBeVisible();
  await setTheme(page, "dark");
  await capture(page, "multi-gpu-overview-desktop-dark.png");

  await setTheme(page, "light");
  await page.getByRole("tab", { name: "Settings" }).click();
  await expect(page.getByRole("combobox", { name: "VA-API device" })).toHaveValue("/dev/dri/renderD128");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("combobox", { name: "VA-API device" }).scrollIntoViewIfNeeded();
  await settle(page);
  await page.screenshot({ path: path.join(CAPTURE_DIR, "multi-gpu-settings-mobile-light.png"), animations: "disabled", caret: "hide" });
});
