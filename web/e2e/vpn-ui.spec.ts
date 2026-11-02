import { expect, test, type Page } from "@playwright/test";

// The VPN UI against the real server. The tunnel helper is not shipped yet, so every enabled
// tunnel reports `down`; the flow proves the fail-closed story end to end: import a .conf, see
// the tunnel down, route an indexer through it, get `vpn_down` from Test, then force-delete.

const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "streamarr-e2e";
const SUFFIX = Date.now().toString(36);
const TUNNEL = `E2E Mullvad ${SUFFIX}`;
const INDEXER = `vpn-indexer-${SUFFIX}`;

// Syntactically valid demo config: random keys, an endpoint that is never contacted.
const CONF = `[Interface]
PrivateKey = Z6oi7H2za6MjMwPT36Ku4z/lRdgma93CqaRk4RBym8U=
Address = 10.64.12.3/32
DNS = 10.64.0.1
PostUp = iptables -I OUTPUT ! -o %i -j REJECT

[Peer]
PublicKey = 4lWFoXFaZOG/ss35101ZbHXPbLR9DgVeNekWLSXLvik=
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = vpn.example.com:51820
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

test("import a tunnel, route an indexer through it, see vpn_down, force-delete", async ({ page }) => {
  await login(page);

  // --- import a WireGuard config through the two-step wizard ---------------------------
  await page.getByRole("link", { name: "VPN", exact: true }).click();
  await expect(page.getByRole("heading", { name: "VPN tunnels", level: 2 })).toBeVisible();
  await page.getByRole("button", { name: "Add tunnel" }).first().click();

  const dialog = page.getByRole("dialog", { name: "Add VPN tunnel" });
  await dialog.getByRole("radio", { name: /Mullvad VPN/ }).click();
  await dialog.getByLabel(/Paste your WireGuard config/).fill(CONF);
  await dialog.getByRole("button", { name: "Parse configuration" }).click();

  const notes = dialog.getByRole("status", { name: "Import notes" });
  await expect(notes).toContainText("Mullvad VPN");
  await expect(notes).toContainText("PostUp ignored");
  await expect(dialog.getByLabel("Endpoint")).toHaveValue("vpn.example.com:51820");
  await dialog.getByLabel("Name", { exact: true }).fill(TUNNEL);
  await dialog.getByRole("button", { name: "Save tunnel" }).click();
  await expect(dialog).toBeHidden();

  // --- with the helper absent the tunnel reports down, calmly, with the reason ---------
  const card = page.getByRole("listitem", { name: TUNNEL });
  await expect(card.getByText("Down", { exact: true })).toBeVisible();
  await expect(card.getByText("helper not started yet")).toBeVisible();
  await expect(card.getByText("This device's public key")).toBeVisible();
  await card.getByRole("button", { name: `Test ${TUNNEL}` }).click();
  await expect(card.getByText(/Test failed/)).toBeVisible();

  // --- route a new indexer through the tunnel ------------------------------------------
  await page.getByRole("link", { name: "Indexers" }).click();
  await expect(page.getByRole("heading", { name: "Indexers", level: 2 })).toBeVisible();
  await page.getByRole("button", { name: /add.*indexer/i }).first().click();
  const indexerDialog = page.getByRole("dialog");
  await indexerDialog.getByLabel("Name").fill(INDEXER);
  await indexerDialog.getByLabel("Base URL").fill("https://vpn-indexer.example");
  await indexerDialog.getByLabel("API key").fill("vpn-key");
  await indexerDialog.getByLabel("Connection").selectOption({ label: `via ${TUNNEL} – down` });
  await indexerDialog.getByRole("button", { name: /add indexer/i }).click();
  await expect(indexerDialog).toBeHidden();

  const row = page.getByRole("listitem").filter({ hasText: INDEXER });
  await expect(row.getByText(`via ${TUNNEL} · VPN down`)).toBeVisible();
  await row.getByRole("button", { name: "Test", exact: true }).click();
  await expect(row.getByText(`Tunnel “${TUNNEL}” is not connected; nothing is sent until it is.`, { exact: true })).toBeVisible();

  // --- deleting the tunnel in use names the indexer and offers to set it direct --------
  await page.getByRole("link", { name: "VPN", exact: true }).click();
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
