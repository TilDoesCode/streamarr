import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "streamarr-e2e";
const SOURCE_TOKEN = "predownload-source-session";
const TARGET_TOKEN = "predownload-target-session";
const CAPTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../test-results/pre-download-ui",
);

const capturePaths = {
  settings: path.join(CAPTURE_DIR, "settings-desktop-light.png"),
  settingsMobile: path.join(CAPTURE_DIR, "settings-mobile-dark.png"),
  session: path.join(CAPTURE_DIR, "session-diagnostics-desktop-dark.png"),
  ephemeral: path.join(CAPTURE_DIR, "ephemeral-background-mobile-dark.png"),
};

async function login(page: Page) {
  await page.addInitScript(() => {
    if (!localStorage.getItem("streamarr.theme")) localStorage.setItem("streamarr.theme", "light");
  });
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("link", { name: "Settings" })).toBeVisible();
}

async function fulfillGet(route: Route, body: unknown) {
  if (route.request().method() !== "GET") {
    await route.continue();
    return;
  }
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({
    content: "*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important}",
  });
}

function ago(milliseconds: number) {
  return new Date(Date.now() - milliseconds).toISOString();
}

function later(milliseconds: number) {
  return new Date(Date.now() + milliseconds).toISOString();
}

const sourceSession = {
  token: SOURCE_TOKEN,
  releaseId: "Asterion.Station.S02E06.2160p.WEB-DL.DDP5.1.HDR-ORBIT",
  workId: "tmdb-tv-438271-s02e06",
  state: "ready",
  container: "mkv",
  sizeBytes: 10_000_000_000,
  bytesServed: 7_500_000_000,
  nntpConnectionsInFlight: 2,
  nntpCommandsTotal: 1_482,
  client: "jellyfin",
  requestedById: "e2e-viewer",
  requestedByName: "Mara Voss",
  createdAt: ago(22 * 60_000),
  lastAccessedAt: ago(1_500),
  expiresAt: later(45 * 60_000),
  retentionPriority: "normal",
  preDownloadedBytes: 0,
  preDownloadTotalBytes: 0,
  preDownloadPercent: 0,
  localCacheReady: false,
  timeline: [],
};

const sourceFile = {
  ...sourceSession,
  title: "Asterion Station — The Quiet Array",
  fileName: "Asterion.Station.S02E06.The.Quiet.Array.2160p.mkv",
  chunksQueried: 960,
  totalChunks: 1_280,
  estimatedStreamedPercent: 75,
  cachedChunks: 164,
  storageBytes: 1_281_000_000,
  isStreaming: true,
  purgeAt: sourceSession.expiresAt,
};

const nextEpisodeJob = {
  id: "predownload-next-s02e07",
  state: "downloading",
  kind: "nextEpisode",
  reason: "Watch progress reached 75%",
  priority: "low",
  sourceToken: SOURCE_TOKEN,
  sourceReleaseId: sourceSession.releaseId,
  sourceWorkId: sourceSession.workId,
  targetToken: TARGET_TOKEN,
  targetReleaseId: "Asterion.Station.S02E07.2160p.WEB-DL.DDP5.1.HDR-ORBIT",
  targetWorkId: "tmdb-tv-438271-s02e07",
  targetTitle: "Asterion Station — Signal in the Dust",
  targetSeasonNumber: 2,
  targetEpisodeNumber: 7,
  bytesDownloaded: 3_800_000_000,
  totalBytes: 10_000_000_000,
  progressPercent: 38,
  watchPositionTicks: 21_600_000_000,
  watchDurationTicks: 28_800_000_000,
  watchProgressPercent: 75,
  triggerThreshold: 75,
  triggerUnit: "percent",
  queuedAt: ago(48_000),
  startedAt: ago(45_000),
  updatedAt: ago(900),
};

const backgroundTargetFile = {
  token: TARGET_TOKEN,
  releaseId: nextEpisodeJob.targetReleaseId,
  workId: nextEpisodeJob.targetWorkId,
  title: "Asterion Station — Signal in the Dust",
  fileName: "Asterion.Station.S02E07.Signal.in.the.Dust.2160p.mkv",
  state: "ready",
  container: "mkv",
  client: "jellyfin",
  requestedById: "e2e-viewer",
  requestedByName: "Mara Voss",
  sizeBytes: 10_000_000_000,
  bytesServed: 0,
  chunksQueried: 38,
  totalChunks: 1_280,
  estimatedStreamedPercent: 3,
  cachedChunks: 16,
  storageBytes: 128_000_000,
  retentionPriority: "background",
  preDownloadJobId: "predownload-next-s02e07-cancelled",
  preDownloadKind: "nextEpisode",
  preDownloadReason: "Watch progress reached 75%",
  preDownloadSourceToken: SOURCE_TOKEN,
  preDownloadState: "cancelled",
  preDownloadedBytes: 4_200_000_000,
  preDownloadTotalBytes: 10_000_000_000,
  preDownloadPercent: 42,
  localCacheReady: false,
  isStreaming: false,
  createdAt: ago(90_000),
  lastAccessedAt: ago(90_000),
  purgeAt: later(38 * 60_000),
};

test("captures the pre-download settings, session diagnostics, and mobile background file", async ({
  page,
}, testInfo) => {
  await mkdir(CAPTURE_DIR, { recursive: true });
  let ephemeralFiles: unknown[] = [sourceFile];

  await page.route("**/api/v1/config/pre-download", (route) => fulfillGet(route, {
    enabled: true,
    downloadCurrentFile: true,
    currentFileThresholdSeconds: 10,
    downloadNextEpisode: true,
    nextEpisodeThresholdPercent: 75,
    preferSimilarNextEpisodeRelease: true,
    nextEpisodeReleaseSimilarityThresholdPercent: 75,
    maxConcurrentDownloads: 1,
  }));
  await page.route("**/api/v1/sessions", (route) => fulfillGet(route, [sourceSession]));
  await page.route("**/api/v1/ephemeral-files", (route) => fulfillGet(route, ephemeralFiles));
  await page.route("**/api/v1/streams?**", (route) => fulfillGet(route, []));
  await page.route("**/api/v1/events?**", (route) => fulfillGet(route, []));
  await page.route("**/api/v1/pre-downloads?**", (route) => fulfillGet(route, [nextEpisodeJob]));

  await login(page);

  // 1. Real authenticated Settings navigation; only the policy GET is supplied by the test.
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Pre-download" }).click();
  await expect(page.getByText("Background caching is active")).toBeVisible();
  await expect(page.getByRole("switch", { name: "Enable pre-download" })).toBeChecked();
  await expect(page.getByLabel("Playback grace period")).toHaveValue("10");
  await expect(page.getByLabel("Watch-progress trigger")).toHaveValue("75");
  await expect(page.getByRole("switch", {
    name: "Prefer a similar next-episode release",
  })).toBeChecked();
  await expect(page.getByLabel("Minimum title similarity")).toHaveValue("75");
  await settle(page);
  await page.screenshot({
    path: capturePaths.settings,
    fullPage: true,
    animations: "disabled",
    caret: "hide",
  });
  await testInfo.attach("pre-download settings — desktop light", {
    path: capturePaths.settings,
    contentType: "image/png",
  });

  // 2. The same release-continuity controls remain readable without horizontal overflow on mobile.
  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText("Release continuity")).toBeVisible();
  await expect(page.getByLabel("Minimum title similarity")).toHaveValue("75");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await settle(page);
  await page.screenshot({
    path: capturePaths.settingsMobile,
    fullPage: true,
    animations: "disabled",
    caret: "hide",
  });
  await testInfo.attach("pre-download release continuity — mobile dark", {
    path: capturePaths.settingsMobile,
    contentType: "image/png",
  });

  // 3. The real session route with a single mocked next-episode job: 75% watch, 38% disk.
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.goto(`/sessions/${SOURCE_TOKEN}`);
  // Pre-download diagnostics now live on their own sub screen rather than the long-scrolling
  // stream-details page.
  await page.getByRole("tab", { name: "Pre-downloads" }).click();
  const diagnostics = page.locator('section[aria-label="Pre-download diagnostics"]');
  await expect(diagnostics.getByRole("heading", { name: "Pre-download diagnostics" })).toBeVisible();
  await expect(diagnostics.getByText("S02E07 · Asterion Station — Signal in the Dust")).toBeVisible();
  await expect(diagnostics.getByRole("progressbar", { name: /client-reported watch progress/i })).toHaveAttribute("aria-valuenow", "75");
  await expect(diagnostics.getByRole("progressbar", { name: /ephemeral disk pre-download progress/i })).toHaveAttribute("aria-valuenow", "38");
  await settle(page);
  await diagnostics.screenshot({
    path: capturePaths.session,
    animations: "disabled",
    caret: "hide",
  });
  await testInfo.attach("next-episode diagnostics — desktop dark", {
    path: capturePaths.session,
    contentType: "image/png",
  });

  // 4. Mobile operational view for a lower-retention target with a cancelled partial file —
  // retention reasons (stream vs pre-download, since/until) now live on the Files screen.
  ephemeralFiles = [backgroundTargetFile];
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/files");
  await expect(page.getByRole("heading", { name: "Held right now" })).toBeVisible();
  const target = page.locator("li").filter({ hasText: "Asterion Station — Signal in the Dust" }).first();
  await expect(target).toBeVisible();
  await expect(target.getByText("Pre-download · next episode")).toBeVisible();
  await expect(target.getByText("Watch progress reached 75%")).toBeVisible();
  await expect(target.getByText(/since \d+/)).toBeVisible();
  await expect(target.getByText(/until in \d+/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await settle(page);
  await page.screenshot({
    path: capturePaths.ephemeral,
    fullPage: true,
    animations: "disabled",
    caret: "hide",
  });
  await testInfo.attach("background ephemeral target — mobile dark", {
    path: capturePaths.ephemeral,
    contentType: "image/png",
  });
});
