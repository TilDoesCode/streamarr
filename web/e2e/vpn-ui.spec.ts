import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// The VPN UI against the real server (docs/vpn.md). Two stories:
//  1. fail closed: a tunnel whose endpoint never answers is `down` with the reason, an indexer routed
//     through it answers `vpn_down` from Test, and deleting the tunnel in use offers "set to direct".
//  2. the loopback WireGuard lab of the E2E harness (a second streamarr-tunnel as the VPN server):
//     import the lab .conf, see `connected` with exit IP and traffic, route an indexer and a provider
//     through it and Test both, watch the helper die and come back on its own, and the dashboard /
//     diagnostics reflect it. Skipped when the harness has no helper binary.
// E2E_SCREENSHOT_DIR=<dir> saves full-page screenshots (light, dark, mobile) of every state.

const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "streamarr-e2e";
const LAB = `http://127.0.0.1:${process.env.E2E_LAB_PORT ?? "5098"}`;
const SCREENS = process.env.E2E_SCREENSHOT_DIR;
const SUFFIX = Date.now().toString(36);

// Syntactically valid demo config: random keys and a TEST-NET endpoint that never answers.
const UNREACHABLE_CONF = `[Interface]
PrivateKey = Z6oi7H2za6MjMwPT36Ku4z/lRdgma93CqaRk4RBym8U=
Address = 10.64.12.3/32
DNS = 10.64.0.1
PostUp = iptables -I OUTPUT ! -o %i -j REJECT

[Peer]
PublicKey = 4lWFoXFaZOG/ss35101ZbHXPbLR9DgVeNekWLSXLvik=
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = 192.0.2.1:51820
PersistentKeepalive = 25
`;

async function login(page: Page) {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("link", { name: "VPN", exact: true })).toBeVisible();
}

async function openVpnPage(page: Page) {
  await page.getByRole("link", { name: "VPN", exact: true }).click();
  await expect(page.getByRole("heading", { name: "VPN tunnels", level: 2 })).toBeVisible();
}

/** Import a .conf through the two-step wizard; returns the new card and the tunnel id. */
async function importTunnel(page: Page, preset: RegExp, conf: string, name: string): Promise<{ card: Locator; id: string }> {
  await page.getByRole("button", { name: "Add tunnel" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add VPN tunnel" });
  await dialog.getByRole("radio", { name: preset }).click();
  await dialog.getByLabel(/Paste your WireGuard config/).fill(conf);
  await dialog.getByRole("button", { name: "Parse configuration" }).click();
  // Step 2 is prefilled from the import; the notes block only appears when there is something to say.
  await expect(dialog.getByLabel("Endpoint")).toHaveValue(/.+:\d+$/);
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  await dialog.getByRole("button", { name: "Save tunnel" }).click();
  await expect(dialog).toBeHidden();
  const card = page.getByRole("listitem", { name });
  await expect(card).toBeVisible();
  const id = (await card.getAttribute("data-testid"))!.replace(/^tunnel-/, "");
  return { card, id };
}

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate((value) => localStorage.setItem("streamarr.theme", value), theme);
  await page.reload();
  await expect(page.getByRole("heading", { level: 2 })).toBeVisible();
}

async function shot(page: Page, name: string) {
  if (!SCREENS) return;
  fs.mkdirSync(SCREENS, { recursive: true });
  await page.screenshot({ path: path.join(SCREENS, `${name}.png`), fullPage: true });
}

/** Light and dark full-page screenshots of the current route; leaves the page in light mode. */
async function shotThemed(page: Page, name: string, settle?: (page: Page) => Promise<void>) {
  await shot(page, `${name}-light`);
  await setTheme(page, "dark");
  if (settle) await settle(page);
  await shot(page, `${name}-dark`);
  await setTheme(page, "light");
  if (settle) await settle(page);
}

test.use({ viewport: { width: 1440, height: 960 } });

test("fail closed: an unreachable tunnel is down, a routed indexer answers vpn_down, delete offers direct", async ({ page }) => {
  test.setTimeout(180_000);
  const TUNNEL = `E2E Mullvad ${SUFFIX}`;
  const INDEXER = `vpn-indexer-${SUFFIX}`;
  await login(page);
  await openVpnPage(page);

  const { card, id } = await importTunnel(page, /Mullvad VPN/, UNREACHABLE_CONF, TUNNEL);
  await expect(card.getByText("This device's public key")).toBeVisible();

  // No handshake ever arrives: `Connecting` first, `Down` with the reason once the handshake timeout passes
  // (or at once when the helper binary is missing).
  await expect(card.getByText("Down", { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(card.getByText(/handshake timeout: no handshake with 192\.0\.2\.1:51820|helper binary not found|helper exited/)).toBeVisible();
  await shot(page, "fail-closed-tunnel-down");
  await card.getByRole("button", { name: `Test ${TUNNEL}` }).click();
  await expect(card.getByText(/Test failed/)).toBeVisible();

  // --- route a new indexer through the tunnel ------------------------------------------
  await page.getByRole("link", { name: "Indexers" }).click();
  await expect(page.getByRole("heading", { name: "Indexers", level: 2 })).toBeVisible();
  await page.getByRole("button", { name: /add.*indexer/i }).first().click();
  const indexerDialog = page.getByRole("dialog");
  await indexerDialog.getByLabel("Name", { exact: true }).fill(INDEXER);
  await indexerDialog.getByLabel("Base URL").fill("https://vpn-indexer.example");
  await indexerDialog.getByLabel("API key").fill("vpn-key");
  await indexerDialog.getByLabel("Connection", { exact: true }).selectOption(id);
  await indexerDialog.getByRole("button", { name: /add indexer/i }).click();
  await expect(indexerDialog).toBeHidden();

  const row = page.getByRole("listitem").filter({ hasText: INDEXER });
  await expect(row.getByText(`via ${TUNNEL} · VPN down`)).toBeVisible();
  await row.getByRole("button", { name: "Test", exact: true }).click();
  await expect(row.getByText(`Tunnel “${TUNNEL}” is not connected; nothing is sent until it is.`, { exact: true })).toBeVisible();
  await expect(row.getByRole("link", { name: "Open VPN" })).toBeVisible();

  // --- deleting the tunnel in use names the indexer and offers to set it direct --------
  await openVpnPage(page);
  await page.getByRole("button", { name: `Delete ${TUNNEL}` }).click();
  const confirm = page.getByRole("dialog");
  await confirm.getByRole("button", { name: "Remove" }).click();
  await expect(confirm.getByRole("heading", { name: "This tunnel is still in use" })).toBeVisible();
  await expect(confirm.getByRole("list", { name: "Routed through this tunnel" })).toContainText(INDEXER);
  await confirm.getByRole("button", { name: "Set them to direct and delete" }).click();
  await expect(confirm).toBeHidden();
  await expect(page.getByRole("listitem", { name: TUNNEL })).toHaveCount(0);

  await page.getByRole("link", { name: "Indexers" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: INDEXER }).getByText("Direct", { exact: true })).toBeVisible();
});

test.describe("lab tunnel (connected)", () => {
  let labStatus: Record<string, unknown> | null = null;

  test.beforeAll(async ({ request }) => {
    labStatus = await fetchLab(request, "/lab/status").catch(() => null);
    test.skip(!labStatus, "the harness has no WireGuard lab (streamarr-tunnel is not built)");
  });

  test("import the lab tunnel, route an indexer and a provider through it, survive helper and peer loss", async ({ page, request }) => {
    test.setTimeout(420_000);
    const TUNNEL = `Lab VPN ${SUFFIX}`;
    const INDEXER = `lab-indexer-${SUFFIX}`;
    const PROVIDER = `lab-provider-${SUFFIX}`;
    const conf = await (await request.get(`${LAB}/lab/tunnel.conf`)).text();
    expect(conf).toContain("[Interface]");

    await login(page);
    await openVpnPage(page);

    // (a) the tunnel comes up: handshake over loopback UDP, exit IP seen through the tunnel, bytes flowing.
    const { card, id } = await importTunnel(page, /Custom WireGuard/, conf, TUNNEL);
    await expect(card.getByText("Connected", { exact: true })).toBeVisible({ timeout: 90_000 });
    await expect(card.getByText("10.200.0.2", { exact: true })).toBeVisible();
    await expect(card.getByText(/^Latency$/)).toBeVisible();
    await expect(card.getByText(/^Handshake$/)).toBeVisible();
    await expect.poll(async () => card.getByTitle("Received").textContent(), { timeout: 30_000 }).not.toMatch(/^\s*0 B\s*$/);
    await expect.poll(async () => card.getByTitle("Sent").textContent(), { timeout: 30_000 }).not.toMatch(/^\s*0 B\s*$/);
    await expect(page.getByText(/1 connected/)).toBeVisible();
    await shotThemed(page, "vpn-connected", async (p) => {
      await expect(p.getByRole("listitem", { name: TUNNEL }).getByText("Connected", { exact: true })).toBeVisible();
    });

    // (b) the inline Test: handshake OK, exit IP, latency.
    await card.getByRole("button", { name: `Test ${TUNNEL}` }).click();
    const testResult = card.getByRole("status");
    await expect(testResult.getByText("Handshake OK")).toBeVisible({ timeout: 30_000 });
    await expect(testResult.getByText("10.200.0.2", { exact: true })).toBeVisible();
    await shot(page, "vpn-test-result-light");
    await setTheme(page, "dark");
    await page.getByRole("listitem", { name: TUNNEL }).getByRole("button", { name: `Test ${TUNNEL}` }).click();
    await expect(page.getByRole("listitem", { name: TUNNEL }).getByRole("status").getByText("Handshake OK")).toBeVisible({ timeout: 30_000 });
    await shot(page, "vpn-test-result-dark");
    await setTheme(page, "light");

    // (c) an indexer behind the tunnel: hostname resolved inside the tunnel, caps fetched through it.
    await page.getByRole("link", { name: "Indexers" }).click();
    await expect(page.getByRole("heading", { name: "Indexers", level: 2 })).toBeVisible();
    await page.getByRole("button", { name: /add.*indexer/i }).first().click();
    const indexerDialog = page.getByRole("dialog");
    await indexerDialog.getByLabel("Name", { exact: true }).fill(INDEXER);
    await indexerDialog.getByLabel("Base URL").fill(String(labStatus!.indexerBaseUrl));
    await indexerDialog.getByLabel("API key").fill("lab-key");
    await indexerDialog.getByLabel("Connection", { exact: true }).selectOption(id);
    await indexerDialog.getByRole("button", { name: /add indexer/i }).click();
    await expect(indexerDialog).toBeHidden();
    const indexerRow = page.getByRole("listitem").filter({ hasText: INDEXER });
    await expect(indexerRow.getByText(`via ${TUNNEL}`, { exact: true })).toBeVisible();
    await indexerRow.getByRole("button", { name: "Test", exact: true }).click();
    await expect(indexerRow.getByText(/Latency \d+ ms/)).toBeVisible({ timeout: 30_000 });
    await shotThemed(page, "indexers-via-tunnel", async (p) => {
      await expect(p.getByRole("listitem").filter({ hasText: INDEXER }).getByText(`via ${TUNNEL}`, { exact: true })).toBeVisible();
    });
    const hostsSeen = (await fetchLab(request, "/lab/status")).hosts as string[];
    expect(hostsSeen).toContain("indexer.test");

    // (d) a provider behind the tunnel: NNTP connect + AUTHINFO through SOCKS5 → WireGuard → the mock server.
    await page.getByRole("link", { name: "Usenet Providers" }).click();
    await expect(page.getByRole("heading", { level: 2 })).toBeVisible();
    await page.getByRole("button", { name: "Add provider" }).first().click();
    const providerDialog = page.getByRole("dialog", { name: "Add provider" });
    await providerDialog.getByLabel("Name", { exact: true }).fill(PROVIDER);
    await providerDialog.getByLabel("Host", { exact: true }).fill(String(labStatus!.nntpHost));
    await providerDialog.getByLabel("Port", { exact: true }).fill(String(labStatus!.nntpPort));
    await providerDialog.getByLabel("Username", { exact: true }).fill("user");
    await providerDialog.getByLabel("Password", { exact: true }).fill("pass");
    const ssl = providerDialog.getByRole("switch", { name: "Use SSL" });
    if (await ssl.isChecked()) await ssl.click();
    await providerDialog.getByLabel("Connection", { exact: true }).selectOption(id);
    await providerDialog.getByRole("button", { name: "Add provider" }).click();
    await expect(providerDialog).toBeHidden();
    const providerRow = page.getByRole("listitem").filter({ hasText: PROVIDER });
    await expect(providerRow.getByText(`via ${TUNNEL}`, { exact: true })).toBeVisible();
    await providerRow.getByRole("button", { name: "Check", exact: true }).click();
    await expect(providerRow.getByText(/\d+ \/ \d+ connections/)).toBeVisible({ timeout: 30_000 });
    await shotThemed(page, "providers-via-tunnel", async (p) => {
      await expect(p.getByRole("listitem").filter({ hasText: PROVIDER }).getByText(`via ${TUNNEL}`, { exact: true })).toBeVisible();
    });

    // (e) dashboard tile.
    await page.getByRole("link", { name: "Dashboard" }).click();
    const tile = page.getByTestId("vpn-tile");
    await expect(tile).toContainText("1 connected", { timeout: 30_000 });
    await expect(tile.getByRole("link", { name: "Manage VPN" })).toBeVisible();
    await shotThemed(page, "dashboard-vpn-tile", async (p) => {
      await expect(p.getByTestId("vpn-tile")).toContainText("1 connected");
    });

    // (i) diagnostics lists the tunnel as a component.
    await page.getByRole("link", { name: "Diagnostics" }).click();
    await expect(page.getByRole("heading", { name: "Diagnostics", level: 2 })).toBeVisible();
    await expect(page.getByText(TUNNEL).first()).toBeVisible({ timeout: 60_000 });
    await shotThemed(page, "diagnostics-tunnel", async (p) => {
      await expect(p.getByText(TUNNEL).first()).toBeVisible({ timeout: 60_000 });
    });

    // (f) the VPN server disappears and the helper is killed: the restarted helper never gets a handshake,
    //     so the tunnel is `down` with the handshake timeout — and nothing routed is sent meanwhile.
    await fetchLab(request, "/lab/peer/stop", "POST");
    const killed = (await fetchLab(request, "/lab/helper/kill", "POST")).killed as number[];
    expect(killed.length).toBeGreaterThan(0);
    await openVpnPage(page);
    const downCard = page.getByRole("listitem", { name: TUNNEL });
    await expect(downCard.getByText("Down", { exact: true })).toBeVisible({ timeout: 120_000 });
    await expect(downCard.getByText(/handshake timeout: no handshake with 127\.0\.0\.1:\d+ after \d+s|helper exited with code/)).toBeVisible();
    await shotThemed(page, "vpn-down", async (p) => {
      await expect(p.getByRole("listitem", { name: TUNNEL }).getByText("Down", { exact: true })).toBeVisible();
    });

    // (g) the indexer test fails closed with the vpn_down message and a way to the VPN page.
    await page.getByRole("link", { name: "Indexers" }).click();
    const blockedRow = page.getByRole("listitem").filter({ hasText: INDEXER });
    await expect(blockedRow.getByText(`via ${TUNNEL} · VPN down`)).toBeVisible({ timeout: 30_000 });
    await blockedRow.getByRole("button", { name: "Test", exact: true }).click();
    await expect(blockedRow.getByText(`Tunnel “${TUNNEL}” is not connected; nothing is sent until it is.`, { exact: true })).toBeVisible();
    await expect(blockedRow.getByRole("link", { name: "Open VPN" })).toBeVisible();
    const hitsWhileDown = Number((await fetchLab(request, "/lab/status")).httpHits);
    await shotThemed(page, "indexer-test-vpn-down", async (p) => {
      const r = p.getByRole("listitem").filter({ hasText: INDEXER });
      await r.getByRole("button", { name: "Test", exact: true }).click();
      await expect(r.getByRole("link", { name: "Open VPN" })).toBeVisible();
    });
    expect(Number((await fetchLab(request, "/lab/status")).httpHits)).toBe(hitsWhileDown);

    // (h) the VPN server is back: the supervisor's restart loop reconnects without anyone touching the UI.
    await fetchLab(request, "/lab/peer/start", "POST");
    await openVpnPage(page);
    const backCard = page.getByRole("listitem", { name: TUNNEL });
    await expect(backCard.getByText("Connected", { exact: true })).toBeVisible({ timeout: 150_000 });
    await expect(backCard.getByText("10.200.0.2", { exact: true })).toBeVisible();
    await shotThemed(page, "vpn-reconnected", async (p) => {
      await expect(p.getByRole("listitem", { name: TUNNEL }).getByText("Connected", { exact: true })).toBeVisible();
    });
    await page.getByRole("link", { name: "Indexers" }).click();
    const recoveredRow = page.getByRole("listitem").filter({ hasText: INDEXER });
    await expect(recoveredRow.getByText(`via ${TUNNEL}`, { exact: true })).toBeVisible({ timeout: 30_000 });
    await recoveredRow.getByRole("button", { name: "Test", exact: true }).click();
    await expect(recoveredRow.getByText(/Latency \d+ ms/)).toBeVisible({ timeout: 30_000 });

    // Streams and the playback preview keep working: they are direct by design and unaffected by the tunnel.
    await page.getByRole("link", { name: "Streams" }).click();
    await expect(page.getByRole("heading", { level: 2 })).toBeVisible();
    await page.getByRole("link", { name: "Playback Preview" }).click();
    await expect(page.getByRole("heading", { level: 2 })).toBeVisible();

    // A phone-width look at the VPN page.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/vpn");
    await expect(page.getByRole("listitem", { name: TUNNEL }).getByText("Connected", { exact: true })).toBeVisible({ timeout: 30_000 });
    await shot(page, "vpn-connected-mobile-390");
  });
});

async function fetchLab(request: APIRequestContext, route: string, method: "GET" | "POST" = "GET"): Promise<Record<string, unknown>> {
  const response = method === "GET" ? await request.get(`${LAB}${route}`) : await request.post(`${LAB}${route}`);
  if (!response.ok()) throw new Error(`${method} ${route}: ${response.status()}`);
  return (await response.json()) as Record<string, unknown>;
}
