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

test("login → add indexer → search → resolve → preview-play, with Jellyfin absent", async ({
  page,
}) => {
  await login(page);

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

  // --- run a search in the debug playground (BRIEF §9.1.5) -----------------------------
  await page.getByRole("link", { name: "Search / Debug" }).click();
  await page.getByLabel("Query", { exact: true }).fill("Example Movie");
  await page.getByRole("button", { name: /^search$/i }).click();

  // The canned release surfaces in the results table.
  const releaseCell = page.getByText(RELEASE_TITLE);
  await expect(releaseCell).toBeVisible();

  // --- resolve the release: health check + pre-probed media info (BRIEF §6.2) ----------
  const row = page.locator("tr", { hasText: RELEASE_TITLE });
  await row.getByRole("button", { name: /resolve/i }).click();

  // The resolve outcome shows "ready" and a Play preview link into the playback route.
  await expect(page.getByText("ready", { exact: true })).toBeVisible();
  const playLink = page.getByRole("link", { name: /play preview/i });
  await expect(playLink).toBeVisible();
  await playLink.click();

  // --- preview-play: the architectural canary (BRIEF §9.1.6) ---------------------------
  await expect(page).toHaveURL(/\/playback/);
  const video = page.locator("video");
  await expect(video).toBeVisible();

  // The <video> streams from a same-origin /stream path carrying the token as access_token
  // (a <video> can't set an Authorization header).
  await expect(video).toHaveAttribute("src", /\/api\/v1\/stream\/.*access_token=/);

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
});
