import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "streamarr-e2e";
const STREAM_TOKEN = "logging-visual-session";
const CAPTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../test-results/logs-ui",
);

const capturePaths = {
  desktop: path.join(CAPTURE_DIR, "logs-desktop-light.png"),
  mobile: path.join(CAPTURE_DIR, "logs-mobile-dark.png"),
  stream: path.join(CAPTURE_DIR, "stream-logs-mobile-dark.png"),
};

const logFeed = {
  generatedAt: "2026-08-17T16:42:19.441Z",
  hasMore: true,
  sources: [
    { source: "core", configured: true, available: true, lastCheckedAt: "2026-08-17T16:42:19.441Z" },
    { source: "jellyfin", configured: true, available: true, message: "jellyfin_20260817.log", lastCheckedAt: "2026-08-17T16:42:18.912Z" },
  ],
  entries: [
    {
      id: "core-1842",
      atUtc: "2026-08-17T16:42:18.934Z",
      level: "error",
      source: "core",
      category: "Streamarr.Usenet.Streams.MultiSegmentStream",
      message: "Provider failover exhausted while reading article 184 of Asterion.Station.S02E06",
      exception: "Streamarr.Usenet.UsenetArticleNotFoundException: No provider retained the requested article\n   at Streamarr.Usenet.Streams.MultiSegmentStream.ReadAsync(...)\n   at Streamarr.Server.Controllers.StreamController.Get(...)\n--- request correlation: logging-visual-session",
      releaseId: "Asterion.Station.S02E06.2160p.WEB-DL.DDP5.1.HDR-ORBIT",
      workId: "tmdb-tv-438271-s02e06",
    },
    {
      id: "jellyfin-557",
      atUtc: "2026-08-17T16:42:17.105Z",
      level: "warning",
      source: "jellyfin",
      category: "Jellyfin.Server",
      message: "[WRN] Streamarr playback stalled for release Asterion.Station.S02E06.2160p.WEB-DL.DDP5.1.HDR-ORBIT\nSystem.IO.IOException: The response ended prematurely.",
      releaseId: "Asterion.Station.S02E06.2160p.WEB-DL.DDP5.1.HDR-ORBIT",
      workId: "tmdb-tv-438271-s02e06",
    },
    {
      id: "core-1839",
      atUtc: "2026-08-17T16:42:12.501Z",
      level: "information",
      source: "core",
      category: "Streamarr.Server.Services.ResolveService",
      message: "Playback session admitted after health probe and media inspection",
      releaseId: "Asterion.Station.S02E06.2160p.WEB-DL.DDP5.1.HDR-ORBIT",
      workId: "tmdb-tv-438271-s02e06",
    },
    {
      id: "core-1834",
      atUtc: "2026-08-17T16:41:58.080Z",
      level: "warning",
      source: "core",
      category: "Streamarr.Core.Indexers.IndexerSearchService",
      message: "Indexer OrbitNZB timed out after 2 attempts",
    },
  ],
};

async function login(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("streamarr.theme", "light");
  });
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("link", { name: "Logs" })).toBeVisible();
}

async function fulfillGet(route: Route, body: unknown) {
  if (route.request().method() !== "GET") {
    await route.continue();
    return;
  }
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({
    content: "*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important}",
  });
}

test("renders global and stream-correlated logs on desktop and mobile", async ({ page }, testInfo) => {
  await mkdir(CAPTURE_DIR, { recursive: true });
  await page.route("**/api/v1/logs?**", (route) => {
    const scoped = new URL(route.request().url()).searchParams.has("streamToken");
    return fulfillGet(route, scoped
      ? { ...logFeed, entries: logFeed.entries.filter((entry) => entry.workId), hasMore: false }
      : logFeed);
  });
  await login(page);

  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.getByRole("link", { name: "Logs" }).click();
  await expect(page.getByRole("heading", { name: "System logs" })).toBeVisible();
  await expect(page.getByText("Provider failover exhausted", { exact: false })).toBeVisible();
  await page.getByText("Exception details").click();
  await expect(page.getByText("UsenetArticleNotFoundException", { exact: false })).toBeVisible();
  await settle(page);
  await page.screenshot({ path: capturePaths.desktop, fullPage: true, animations: "disabled", caret: "hide" });
  await testInfo.attach("system logs — desktop light", { path: capturePaths.desktop, contentType: "image/png" });

  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("html")).toHaveClass(/dark/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await settle(page);
  await page.screenshot({ path: capturePaths.mobile, fullPage: true, animations: "disabled", caret: "hide" });
  await testInfo.attach("system logs — mobile dark", { path: capturePaths.mobile, contentType: "image/png" });

  const now = new Date().toISOString();
  await page.route("**/api/v1/sessions", (route) => fulfillGet(route, [{
    token: STREAM_TOKEN,
    releaseId: "Asterion.Station.S02E06.2160p.WEB-DL.DDP5.1.HDR-ORBIT",
    workId: "tmdb-tv-438271-s02e06",
    state: "streaming",
    container: "mkv",
    sizeBytes: 10_000_000_000,
    bytesServed: 1_900_000_000,
    nntpConnectionsInFlight: 1,
    nntpCommandsTotal: 278,
    client: "jellyfin",
    requestedByName: "Mara Voss",
    createdAt: now,
    lastAccessedAt: now,
    expiresAt: now,
    timeline: [],
  }]));
  await page.route("**/api/v1/ephemeral-files", (route) => fulfillGet(route, [{
    token: STREAM_TOKEN,
    title: "Asterion Station — The Quiet Array",
    fileName: "Asterion.Station.S02E06.The.Quiet.Array.2160p.mkv",
    sizeBytes: 10_000_000_000,
    bytesServed: 1_900_000_000,
    chunksQueried: 244,
    totalChunks: 1280,
    cachedChunks: 38,
    storageBytes: 302_000_000,
    estimatedStreamedPercent: 19,
  }]));
  await page.route("**/api/v1/metrics", (route) => fulfillGet(route, {
    connections: { budget: 16, inUse: 1, providers: [] },
  }));
  await page.route("**/api/v1/events?**", (route) => fulfillGet(route, []));
  await page.route("**/api/v1/pre-downloads?**", (route) => fulfillGet(route, []));
  await page.route(`**/api/v1/sessions/${STREAM_TOKEN}/articles`, (route) => fulfillGet(route, {
    releaseId: "Asterion.Station.S02E06.2160p.WEB-DL.DDP5.1.HDR-ORBIT",
    totalArticles: 0,
    pendingArticles: 0,
    activeArticles: 0,
    downloadedArticles: 0,
    cachedArticles: 0,
    failedArticles: 0,
    downloadedBytes: 0,
    averageDurationMs: 0,
    effectiveBytesPerSecond: 0,
    updatedAt: now,
    providers: [],
    articles: [],
  }));

  await page.goto(`/sessions/${STREAM_TOKEN}`);
  // Logs now live on their own sub screen rather than the long-scrolling stream-details page.
  await page.getByRole("tab", { name: "Logs" }).click();
  const streamLogs = page.locator('section[aria-label="Stream logs"]');
  await expect(streamLogs.getByRole("heading", { name: "Core & Jellyfin logs" })).toBeVisible();
  await expect(streamLogs.getByText("Provider failover exhausted", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await settle(page);
  await page.addStyleTag({ content: "header.sticky{position:static!important}" });
  await streamLogs.screenshot({ path: capturePaths.stream, animations: "disabled", caret: "hide" });
  await testInfo.attach("stream-correlated logs — mobile dark", { path: capturePaths.stream, contentType: "image/png" });
});
