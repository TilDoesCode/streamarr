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
  await expect(peer.getByRole("heading", { name: "Sessions", level: 2 })).toBeVisible();

  // Every live stream drills into a real observability view backed by the same session,
  // ephemeral-file, metrics and playback-event APIs.
  await peer.getByRole("link", { name: /inspect stream/i }).last().click();
  await expect(peer).toHaveURL(/\/sessions\/[^/]+$/);
  await expect(peer.getByText("Live signal")).toBeVisible();
  await expect(peer.getByRole("heading", { name: "Identity & lifecycle" })).toBeVisible();
  await peer.getByRole("link", { name: /all streams/i }).click();

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

  // Keep visual proof from the real browser run: both operational views must show exactly one
  // retained capability/file after the explicit pause → resolve → ranged continuation cycle.
  await peer.setViewportSize({ width: 1440, height: 1000 });
  await expect(peer.getByText(/^1 live ·/)).toBeVisible();
  const sessionsScreenshot = testInfo.outputPath("resume-reuses-session.png");
  await peer.screenshot({ path: sessionsScreenshot, fullPage: true });
  await testInfo.attach("resume reuses one Core session", {
    path: sessionsScreenshot,
    contentType: "image/png",
  });

  await peer.getByRole("link", { name: "Ephemeral Files" }).click();
  await expect(peer.getByRole("heading", { name: "Ephemeral files", level: 2 })).toBeVisible();
  await expect(peer.getByText("Retained files")).toBeVisible();
  await expect(peer.getByText("1", { exact: true }).first()).toBeVisible();
  const filesScreenshot = testInfo.outputPath("resume-reuses-ephemeral-file.png");
  await peer.screenshot({ path: filesScreenshot, fullPage: true });
  await testInfo.attach("resume reuses one ephemeral file", {
    path: filesScreenshot,
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
