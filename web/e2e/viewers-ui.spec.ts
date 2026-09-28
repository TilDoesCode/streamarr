import { expect, test, type Page } from "@playwright/test";
import { createHmac } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Drives the REAL server: module switch, viewer accounts, the viewer test harness (sign-in, player, next up, age gate).

const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "streamarr-e2e";
const CAPTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../test-results/viewers-ui");
const PASSWORD = "correct horse battery";

async function login(page: Page) {
  await page.addInitScript(() => {
    if (!localStorage.getItem("streamarr.theme")) localStorage.setItem("streamarr.theme", "light");
  });
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("link", { name: "Viewers" })).toBeVisible();
}

async function api(page: Page, method: "POST" | "PUT", url: string, data: unknown) {
  const origin = new URL(page.url()).origin;
  const response = await page.request.fetch(url, { method, data, headers: { Origin: origin } });
  expect(response.ok(), `${method} ${url}: ${await response.text()}`).toBeTruthy();
  return response.json().catch(() => null);
}

async function setTheme(page: Page, theme: "light" | "dark") {
  const isDark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
  if ((theme === "dark") !== isDark) {
    await page.getByRole("button", { name: theme === "dark" ? "Switch to dark mode" : "Switch to light mode" }).first().click();
  }
}

async function capture(page: Page, name: string) {
  const viewport = page.viewportSize()!;
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: viewport.width, height: Math.min(Math.max(height, viewport.height), 4_000) });
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: "*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important}" });
  await page.screenshot({ path: path.join(CAPTURE_DIR, name), animations: "disabled", caret: "hide" });
  await page.setViewportSize(viewport);
}

function totp(secret: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = secret.replace(/[\s=]/g, "").toUpperCase().split("").map((c) => alphabet.indexOf(c).toString(2).padStart(5, "0")).join("");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const hmac = createHmac("sha1", key).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

test.describe.configure({ mode: "serial" });

test("viewer accounts: module switch, accounts, harness sign-in, watch state and next up", async ({ page }) => {
  test.setTimeout(240_000);
  await mkdir(CAPTURE_DIR, { recursive: true });
  await login(page);
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.getByRole("link", { name: "Viewers" }).click();
  await expect(page).toHaveURL(/\/viewers/);
  await expect(page.getByText("The viewer module is switched off").first()).toBeVisible();
  await capture(page, "01-module-disabled-light.png");

  await page.getByRole("button", { name: "Enable module" }).first().click();
  await expect(page.getByText("The viewer module is switched off")).toHaveCount(0);
  await api(page, "PUT", "/api/v1/config/viewers/settings", { serverName: "Home Cinema", email: { mode: "outbox" } });

  await page.getByRole("button", { name: /New viewer/ }).click();
  const form = page.getByRole("form", { name: "New viewer" });
  await form.getByLabel("Username").fill("anna");
  await form.getByLabel("Display name").fill("Anna");
  await form.getByLabel("Email (optional)").fill("anna@example.com");
  await form.getByText("Set", { exact: true }).click();
  await form.getByLabel("Initial password").fill(PASSWORD);
  const mustChange = form.getByLabel("Must change password at next sign-in");
  if (await mustChange.isChecked()) await mustChange.click();
  await form.getByRole("button", { name: /create/i }).click();
  await expect(page.getByText("@anna").first()).toBeVisible();

  await api(page, "POST", "/api/v1/config/viewers", {
    username: "ben", displayName: "Ben (12)", password: PASSWORD, mustChangePassword: true,
    permissions: { maxAge: 12, blockUnrated: true, allowTranscoding: false, maxConcurrentStreams: 1 },
  });
  await api(page, "POST", "/api/v1/config/viewers", { username: "guest.tv", displayName: "Guest TV", password: PASSWORD, disabled: true, permissions: { maxAge: 6 } });

  await page.getByRole("button", { name: /New viewer/ }).click();
  const generated = page.getByRole("form", { name: "New viewer" });
  await generated.getByLabel("Username").fill("clara");
  await generated.getByLabel("Display name").fill("Clara");
  await generated.getByRole("button", { name: /create/i }).click();
  await expect(page.getByRole("button", { name: "I copied it" })).toBeVisible();
  await capture(page, "02-generated-password-light.png");
  await page.getByRole("button", { name: "I copied it" }).click();

  await page.reload();
  await expect(page.getByText("@guest.tv").first()).toBeVisible();
  await capture(page, "03-accounts-light.png");
  await setTheme(page, "dark");
  await capture(page, "04-accounts-dark.png");
  await setTheme(page, "light");

  await page.getByRole("tab", { name: /Test harness/ }).click();
  await page.getByRole("button", { name: "@anna" }).click();
  await page.getByRole("form", { name: "Password sign-in" }).getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const session = page.getByRole("region", { name: "Viewer session" });
  await expect(session.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();

  const player = page.getByRole("region", { name: "Player" });
  await player.getByRole("button", { name: /Breaking Bad S01E01/ }).click();
  await player.getByRole("button", { name: /Finish \(95 %\)/ }).click();
  await page.getByRole("tab", { name: /Next up/ }).click();
  const nextUp = page.getByRole("list", { name: "Next up" });
  await expect(nextUp.getByText(/Cat's in the Bag/)).toBeVisible();

  await player.getByRole("button", { name: /The Matrix/ }).click();
  await player.getByLabel("Position").fill("42");
  await player.getByRole("button", { name: "Start" }).click();
  await player.getByRole("button", { name: "Stop" }).click();
  await page.getByRole("tab", { name: /Continue watching/ }).click();
  await expect(page.getByRole("list", { name: "Continue watching" }).getByText(/tmdb-movie-603|The Matrix/).first()).toBeVisible();
  await player.getByRole("button", { name: /Check age gate/ }).click();
  await expect(page.getByRole("status", { name: "Age gate result" })).toBeVisible();

  await page.evaluate(() => window.scrollTo(0, 0));
  await capture(page, "05-harness-signed-in-light.png");
  await page.getByRole("tab", { name: /Next up/ }).click();
  await setTheme(page, "dark");
  await capture(page, "06-harness-signed-in-dark.png");

  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, "07-harness-mobile-dark.png");
  await setTheme(page, "light");
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.getByRole("tab", { name: "Two-factor" }).click();
  await page.locator("#totp-password").fill(PASSWORD);
  await page.getByRole("button", { name: /Set up authenticator/ }).click();
  await expect(page.getByRole("img", { name: "Authenticator QR code" })).toBeVisible();
  const secret = await page.getByRole("form", { name: "Confirm authenticator" }).locator("code").first().innerText();
  await page.getByLabel("Code from the app").fill(totp(secret));
  await capture(page, "07b-two-factor-setup-light.png");
  await page.getByRole("button", { name: /Enable two-factor/ }).click();
  await expect(page.getByRole("button", { name: "I saved them" })).toBeVisible();
  await page.getByRole("button", { name: "I saved them" }).click();

  await session.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("button", { name: "@ben" }).click();
  await page.getByRole("form", { name: "Password sign-in" }).getByLabel("Password").fill("wrong password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText(/Incorrect username or password/).first()).toBeVisible();
  await page.getByRole("form", { name: "Password sign-in" }).getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Password change required").first()).toBeVisible();
  await capture(page, "08-harness-forced-password-change-light.png");

  await page.getByRole("tab", { name: "Settings" }).click();
  await expect(page.getByRole("button", { name: /Save viewer settings/ })).toBeVisible();
  await capture(page, "09-settings-light.png");
  await setTheme(page, "dark");
  await capture(page, "10-settings-dark.png");

  await page.getByRole("tab", { name: /Accounts/ }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, "11-accounts-mobile-dark.png");
});
