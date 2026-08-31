import { test, expect, type Page } from "@playwright/test";

// The single most important test in the repo (BRIEF §3.1 rule 4 / §9 acceptance): an operator
// configures the system from scratch, searches, resolves, and PLAYS a stream in the browser —
// with Jellyfin not running at all. If this passes, the interface-agnostic abstraction holds.

const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "streamarr-e2e";
const RELEASE_TITLE = "Example.Movie.2021.1080p.WEB-DL.x264-STREAMARR";

async function login(page: Page) {
  await page.goto("/");
  // The auth guard redirects an unauthenticated visitor to /login.
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  // Land on the dashboard shell (nav is only rendered once authenticated).
  await expect(page.getByRole("link", { name: "Indexers" })).toBeVisible();
}

interface LiveSessionSnapshot {
  token?: string;
  releaseId?: string;
  workId?: string;
  client?: string | null;
  requestedById?: string | null;
  requestedByName?: string | null;
}

async function liveSessions(page: Page): Promise<LiveSessionSnapshot[]> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/sessions", {
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error(`Could not list sessions (${response.status})`);
    return (await response.json()) as LiveSessionSnapshot[];
  });
}

async function liveSessionCount(page: Page): Promise<number> {
  return (await liveSessions(page)).length;
}

async function ephemeralFileCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/ephemeral-files", {
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error(`Could not list ephemeral files (${response.status})`);
    return ((await response.json()) as unknown[]).length;
  });
}

function failedArticleMap(releaseId: string) {
  const articles = Array.from({ length: 96 }, (_, index) => {
    const base = {
      index,
      fileName: "Example.Movie.2021.1080p.WEB-DL.mkv",
      articleNumber: index + 1,
      expectedBytes: 768_000,
      messageId: `example-part-${String(index + 1).padStart(4, "0")}@streamarr.test`,
      bytes: 0,
      attempts: [] as Record<string, unknown>[],
    };
    if (index === 37) {
      return {
        ...base,
        state: "failed",
        durationMs: 2_634,
        errorType: "UsenetArticleNotFoundException",
        errorMessage: "No configured provider retained this article after failover.",
        attempts: [
          { provider: "Eweka EU", operation: "BODY", outcome: "missing", durationMs: 184, responseCode: 430, errorType: "UsenetArticleNotFoundException", errorMessage: "430 No article with that message-id" },
          { provider: "Blocknews", operation: "BODY", outcome: "error", durationMs: 2_450, errorType: "CouldNotConnectToUsenetException", errorMessage: "The provider did not answer before the command timeout." },
        ],
      };
    }
    if (index === 14 || index === 15) {
      return { ...base, state: "cached", bytes: 768_000, durationMs: 0, successfulProvider: "segment cache" };
    }
    if (index < 48) {
      return {
        ...base,
        state: "downloaded",
        bytes: 768_000,
        durationMs: 140 + (index % 8) * 19,
        throughputBytesPerSecond: 4_800_000,
        successfulProvider: "Eweka EU",
        attempts: [{ provider: "Eweka EU", operation: "BODY", outcome: "success", durationMs: 118, responseCode: 222 }],
      };
    }
    if (index < 50) {
      return {
        ...base,
        state: "downloading",
        bytes: 310_000,
        durationMs: 390,
        successfulProvider: "Eweka EU",
        attempts: [{ provider: "Eweka EU", operation: "BODY", outcome: "success", durationMs: 126, responseCode: 222 }],
      };
    }
    return { ...base, state: "pending" };
  });

  return {
    releaseId,
    totalArticles: articles.length,
    pendingArticles: 46,
    activeArticles: 2,
    downloadedArticles: 45,
    cachedArticles: 2,
    failedArticles: 1,
    downloadedBytes: 36_096_000,
    averageDurationMs: 219,
    effectiveBytesPerSecond: 5_340_000,
    updatedAt: new Date().toISOString(),
    providers: [
      { provider: "Eweka EU", successes: 47, missing: 1, errors: 0, averageDurationMs: 132 },
      { provider: "Blocknews", successes: 0, missing: 0, errors: 1, averageDurationMs: 2_450 },
    ],
    articles,
  };
}

test("login → add indexer → search → resolve → preview-play, with Jellyfin absent", async ({
  page,
  context,
}, testInfo) => {
  await login(page);
  const browserSession = await page.evaluate(() => ({
    local: JSON.parse(window.localStorage.getItem("streamarr.session") ?? "null") as Record<
      string,
      unknown
    > | null,
    sessionValues: Object.values(window.sessionStorage),
  }));
  expect(browserSession.local).toEqual(
    expect.objectContaining({ username: "admin", role: "admin" }),
  );
  expect(browserSession.local).not.toHaveProperty("token");
  expect(browserSession.sessionValues).toEqual([]);
  const adminCookie = (await context.cookies()).find((cookie) => cookie.name === "streamarr_admin");
  expect(adminCookie).toMatchObject({ httpOnly: true, sameSite: "Strict" });
  const sessionsBefore = await liveSessionCount(page);

  // --- inspect the real provider throughput flow without consuming the sample yet ------
  await page.getByRole("link", { name: "Usenet Providers" }).click();
  await expect(page.getByRole("heading", { name: "Usenet Providers", level: 2 })).toBeVisible();
  await page.getByRole("button", { name: "Speed test mock" }).click();
  const speedDialog = page.getByRole("dialog", { name: "Streaming speed test" });
  await expect(speedDialog).toContainText("real NNTP article traffic");
  await expect(speedDialog.getByLabel("Article message-ID (optional)")).toBeVisible();
  await speedDialog.getByRole("button", { name: "Cancel" }).click();

  // --- add an indexer through the UI (BRIEF §9.1) --------------------------------------
  await page.getByRole("link", { name: "Indexers" }).click();
  // Two "Indexers" headings exist (the app-bar title h1 and the page h2) — target the page one.
  await expect(page.getByRole("heading", { name: "Indexers", level: 2 })).toBeVisible();
  await page.getByRole("button", { name: /add.*indexer/i }).first().click();

  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("mock");
  await dialog.getByLabel("Base URL").fill("https://mock.example");
  await dialog.getByLabel("API key").fill("mock-key");
  await dialog.getByLabel("Categories").fill("2000, 5000");
  await dialog.getByRole("button", { name: /add indexer/i }).click();

  // The new indexer appears in the list.
  await expect(page.getByText("mock", { exact: true })).toBeVisible();

  // --- verify production semantic discovery, then inspect raw releases -----------------
  await page.getByRole("link", { name: "Search", exact: true }).click();
  await page.getByLabel("Semantic query").fill("Example Movie");
  await page.getByRole("button", { name: /discover/i }).click();
  await expect(page.getByRole("heading", { name: "Movies" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Example Movie" })).toBeVisible();
  await expect(page.getByRole("img", { name: /example movie poster/i })).toHaveAttribute(
    "src",
    "https://image.example/poster/12345.jpg",
  );
  await page.getByRole("button", { name: /example movie, 1 release, expand details/i }).click();
  await expect(page.getByText(RELEASE_TITLE)).toBeVisible();
  await expect(page.getByRole("link", { name: /play preview/i })).toBeVisible();

  await page.getByRole("tab", { name: /release diagnostics/i }).click();
  await page.getByLabel("Query", { exact: true }).fill("Example Movie");
  await page.getByRole("button", { name: /^search$/i }).click();

  // The canned release surfaces in the results table.
  const releaseCell = page.getByLabel("Search results").getByText(RELEASE_TITLE);
  await expect(releaseCell).toBeVisible();

  // --- resolve the release: health check + pre-probed media info (BRIEF §6.2) ----------
  const row = page.locator("tr", { hasText: RELEASE_TITLE });
  const resolveButton = row.getByRole("button", { name: /resolve/i });

  // Operational table actions remain visible without horizontal scrolling on a phone viewport.
  await page.setViewportSize({ width: 320, height: 720 });
  const resolveBox = await resolveButton.boundingBox();
  expect(resolveBox).not.toBeNull();
  expect(resolveBox!.x).toBeGreaterThanOrEqual(0);
  expect(resolveBox!.x + resolveBox!.width).toBeLessThanOrEqual(320);
  await resolveButton.click();

  // The resolve outcome shows "ready" and a Play preview link into the playback route.
  await expect(
    page.getByLabel("Search results").getByText("ready", { exact: true }),
  ).toBeVisible();
  const playLink = page.getByRole("link", { name: /play preview/i });
  await expect(playLink).toBeVisible();
  await playLink.click();

  // --- preview-play: the architectural canary (BRIEF §9.1.6) ---------------------------
  await expect(page).toHaveURL(/\/playback/);
  const video = page.locator("video");
  await expect(video).toBeVisible();

  // The <video> uses only the short-lived stream capability in its path. The administrator JWT
  // must never appear in a URL.
  await expect(video).toHaveAttribute("src", /^\/api\/v1\/stream\/[^?]+$/);
  expect(await video.getAttribute("src")).not.toContain("access_token");

  // Drive playback: mute (autoplay policy) and play, then assert the browser decoded frames
  // (readyState >= 2 = HAVE_CURRENT_DATA) and the clock actually advances.
  await video.evaluate((el: HTMLVideoElement) => {
    el.muted = true;
    return el.play();
  });

  await expect
    .poll(async () => video.evaluate((el: HTMLVideoElement) => el.readyState), {
      timeout: 30_000,
      message: "video never reached readyState >= 2 (HAVE_CURRENT_DATA)",
    })
    .toBeGreaterThanOrEqual(2);

  await expect
    .poll(async () => video.evaluate((el: HTMLVideoElement) => el.currentTime), {
      timeout: 30_000,
      message: "video.currentTime never advanced — playback did not start",
    })
    .toBeGreaterThan(0);

  // Search already opened the session. Playback must reuse it instead of resolving again.
  await expect.poll(() => liveSessionCount(page)).toBe(sessionsBefore + 1);

  // Pause and explicitly resolve the same release again, mirroring a client that rebuilds its
  // media source before continuing. Core must return the retained capability and file, and a
  // ranged continuation must advance from the requested position on that same stream URL.
  const originalStreamUrl = await video.getAttribute("src");
  const sessionsAtPause = await liveSessionCount(page);
  const filesAtPause = await ephemeralFileCount(page);
  const retainedAtPause = (await liveSessions(page)).find(
    (session) => `/api/v1/stream/${session.token}` === originalStreamUrl,
  );
  expect(retainedAtPause).toBeDefined();
  await video.evaluate((el: HTMLVideoElement) => el.pause());

  const resumedResolveRequest = page.waitForRequest(
    (request) => request.url().includes("/api/v1/resolve") && request.method() === "POST",
  );
  const resumedResolve = page.waitForResponse(
    (response) => response.url().includes("/api/v1/resolve") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: /resolve & load/i }).click();
  const resumedRequest = await resumedResolveRequest;
  const resumedResolveResponse = await resumedResolve;
  expect(resumedResolveResponse.ok()).toBe(true);
  expect(resumedRequest.postDataJSON()).toMatchObject({
    releaseId: retainedAtPause!.releaseId,
    workId: retainedAtPause!.workId,
    client: retainedAtPause!.client,
  });
  const resumedResolveBody = (await resumedResolveResponse.json()) as { streamUrl?: string };
  expect(resumedResolveBody.streamUrl).toBe(originalStreamUrl);
  await expect(video).toHaveAttribute("src", originalStreamUrl!);
  await expect.poll(() => liveSessionCount(page)).toBe(sessionsAtPause);
  await expect.poll(() => ephemeralFileCount(page)).toBe(filesAtPause);

  const duration = await video.evaluate((el: HTMLVideoElement) => el.duration);
  expect(Number.isFinite(duration)).toBe(true);
  expect(duration).toBeGreaterThan(2);
  const resumeAt = duration / 2;
  await video.evaluate(async (el: HTMLVideoElement, seconds: number) => {
    el.currentTime = seconds;
    await el.play();
  }, resumeAt);
  await expect
    .poll(async () => video.evaluate((el: HTMLVideoElement) => el.currentTime), {
      timeout: 30_000,
      message: "continued playback did not advance after the retained-session range seek",
    })
    .toBeGreaterThan(resumeAt);

  // Validate the accessible mobile drawer and sticky Sessions action in a second, synchronized
  // tab while the first tab keeps playing.
  const peer = await context.newPage();
  await peer.setViewportSize({ width: 375, height: 800 });
  await peer.goto("/sessions");
  await expect(peer.getByRole("heading", { name: "Streams", level: 2 })).toBeVisible();

  // Every live stream drills into a real observability view backed by the same session,
  // ephemeral-file, metrics and playback-event APIs.
  const liveLane = peer
    .locator("article")
    .filter({ has: peer.getByRole("button", { name: /force-close session/i }) })
    .first();
  await liveLane.getByRole("link", { name: /inspect stream/i }).click();
  await expect(peer).toHaveURL(/\/sessions\/[^/]+$/);
  await expect(peer.getByText(/^live signal$/i)).toBeVisible();
  // The stream-details screen is now split into sub screens (tabs) so nothing forces a long
  // scroll; each diagnostic lives on its own tab and is only mounted while active.
  await peer.getByRole("tab", { name: "Network & session" }).click();
  await expect(peer.getByRole("heading", { name: "Identity & lifecycle" })).toBeVisible();
  await peer.getByRole("tab", { name: "Articles" }).click();
  await expect(peer.getByRole("heading", { name: "Every article, one live signal" })).toBeVisible();
  await expect(peer.getByRole("list", { name: "Articles in release order" })).toBeVisible();
  const articleFlightMap = peer.locator("section").filter({
    has: peer.getByRole("heading", { name: "Every article, one live signal" }),
  }).first();
  await peer.addStyleTag({ content: "header.sticky { position: static !important; }" });

  if (await peer.getByRole("button", { name: "Switch to light mode" }).isVisible())
    await peer.getByRole("button", { name: "Switch to light mode" }).click();
  const articleMapMobile = testInfo.outputPath("article-map-mobile-light.png");
  await articleFlightMap.screenshot({ path: articleMapMobile });
  await testInfo.attach("article map mobile light", { path: articleMapMobile, contentType: "image/png" });

  await peer.getByRole("button", { name: "Switch to dark mode" }).click();
  await peer.setViewportSize({ width: 1440, height: 1000 });
  const articleMapDesktop = testInfo.outputPath("article-map-desktop-dark.png");
  await articleFlightMap.screenshot({ path: articleMapDesktop });
  await testInfo.attach("article map desktop dark", { path: articleMapDesktop, contentType: "image/png" });

  await peer.route("**/api/v1/sessions/*/articles", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(failedArticleMap(retainedAtPause!.releaseId!)) });
  });
  await peer.reload();
  await peer.addStyleTag({ content: "header.sticky { position: static !important; }" });
  await peer.getByRole("tab", { name: "Articles" }).click();
  await peer.getByRole("button", { name: /failed 1/i }).click();
  await expect(peer.getByRole("alert")).toContainText("No configured provider retained this article after failover.");
  const articleMapFailure = testInfo.outputPath("article-map-provider-failure.png");
  await articleFlightMap.screenshot({ path: articleMapFailure });
  await testInfo.attach("article map provider failure", { path: articleMapFailure, contentType: "image/png" });
  await peer.unroute("**/api/v1/sessions/*/articles");

  await peer.setViewportSize({ width: 375, height: 800 });
  await peer.getByRole("link", { name: /all streams/i }).click();

  const systemLoad = peer.getByRole("region", { name: "Current system load" });
  await expect(systemLoad).toBeVisible();
  await expect(systemLoad.getByRole("group", { name: /Provider ingest:/i })).toBeVisible();
  const streamOutput = systemLoad.getByRole("group", { name: /Client output:/i });
  await expect(streamOutput).toBeVisible();
  await expect(streamOutput).not.toHaveAccessibleName(/Measuring/i);
  await expect(systemLoad.getByRole("group", { name: /Streaming now:/i })).toBeVisible();
  await expect(systemLoad.getByRole("group", { name: /NNTP in use:/i })).toBeVisible();
  await expect(systemLoad.getByText("mock", { exact: true })).toBeVisible();
  expect(await peer.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  if (await peer.getByRole("button", { name: "Switch to light mode" }).isVisible())
    await peer.getByRole("button", { name: "Switch to light mode" }).click();
  const streamsHero = peer.getByRole("heading", { name: "Streams", level: 2 }).locator("xpath=ancestor::section[1]");
  const systemLoadMobile = testInfo.outputPath("stream-load-mobile-light.png");
  await streamsHero.screenshot({ path: systemLoadMobile, animations: "disabled", caret: "hide" });
  await testInfo.attach("stream load mobile light", { path: systemLoadMobile, contentType: "image/png" });

  const closeSession = peer.getByRole("button", { name: /force-close/i }).last();
  const closeBox = await closeSession.boundingBox();
  expect(closeBox).not.toBeNull();
  expect(closeBox!.x).toBeGreaterThanOrEqual(0);
  expect(closeBox!.x + closeBox!.width).toBeLessThanOrEqual(375);

  const menuTrigger = peer.getByRole("button", { name: /open menu/i });
  await menuTrigger.click();
  await expect(peer.getByRole("dialog")).toBeVisible();
  await peer.keyboard.press("Escape");
  await expect(peer.getByRole("dialog")).toBeHidden();
  await expect(menuTrigger).toBeFocused();

  // Capture the live cache, output, global pressure, and provider pool in one panel.
  await peer.getByRole("button", { name: "Switch to dark mode" }).click();
  await peer.setViewportSize({ width: 1440, height: 1000 });
  const sessionsScreenshot = testInfo.outputPath("resume-reuses-stream-ledger.png");
  await peer.screenshot({ path: sessionsScreenshot, fullPage: true, animations: "disabled", caret: "hide" });
  await testInfo.attach("stream load and retained stream ledger", {
    path: sessionsScreenshot,
    contentType: "image/png",
  });

  // Signing out while media is active clears this tab's admin state, stops playback, and logs
  // out every other open console tab through the browser storage event.
  const mainMenu = page.getByRole("button", { name: /open menu/i });
  await mainMenu.click();
  await page.getByRole("dialog").getByRole("button", { name: /sign out/i }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.locator("video")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("streamarr.session")))
    .toBeNull();
  await expect
    .poll(async () => (await context.cookies()).some((cookie) => cookie.name === "streamarr_admin"))
    .toBe(false);
  await expect(peer).toHaveURL(/\/login/);
  await peer.close();
});
