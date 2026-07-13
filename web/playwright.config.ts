import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

// package.json is `type: module`, so `__dirname` is not defined — derive it from import.meta.
const dirname = path.dirname(fileURLToPath(import.meta.url));

// Playwright smoke E2E (BRIEF §9.2). It drives the REAL Core Server — booted by the
// Streamarr.E2E.Harness console app against an in-process mock NNTP server, canned indexer
// + TMDB fixtures and a seeded admin — with **Jellyfin absent**, proving BRIEF §3.1 rule 4:
// the Management UI can log in, configure an indexer, search, resolve and preview-play a
// stream entirely on its own. The harness serves the built SPA at a single origin.

const PORT = process.env.E2E_PORT ?? "5099";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "streamarr-e2e";
const WEB_DIST = path.resolve(dirname, "dist");

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "on-first-retry",
    // Autoplay of muted media without a user gesture — the preview <video> is muted in-test.
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  // Build the SPA, then boot the real server harness serving it. A single self-contained
  // command so `playwright test` works from a clean checkout (and in CI).
  webServer: {
    command:
      "npm run build && dotnet run --project ../server/tests/Streamarr.E2E.Harness/Streamarr.E2E.Harness.csproj -c Release",
    url: `http://127.0.0.1:${PORT}/api/v1/health?deep=false`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      E2E_PORT: PORT,
      E2E_WEB_DIST: WEB_DIST,
      E2E_ADMIN_PASSWORD: ADMIN_PASSWORD,
    },
  },
});
