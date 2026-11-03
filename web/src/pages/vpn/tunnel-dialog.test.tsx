import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import { installFetchRoutes } from "@/test/fetch-routes";
import { setSession } from "@/api/token";
import { KEYS, presets, tunnel } from "@/test/tunnel-fixtures";
import { TunnelDialog } from "./tunnel-dialog";

const CONF = `[Interface]
PrivateKey = ${KEYS.private}
Address = 10.64.12.3/32
DNS = 10.64.0.1, home.lan
MTU = abc
PostUp = iptables -I OUTPUT ! -o %i -j REJECT

[Peer]
PublicKey = ${KEYS.peer}
PresharedKey = ${KEYS.psk}
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = vpn.example.com:51820
`;

const importResponse = {
  valid: false,
  detectedPreset: "mullvad",
  tunnel: {
    name: null,
    preset: "mullvad",
    privateKey: KEYS.private,
    addresses: ["10.64.12.3/32"],
    dns: ["10.64.0.1"],
    mtu: null,
    keepalive: null,
    peerPublicKey: KEYS.peer,
    presharedKey: KEYS.psk,
    endpoint: "vpn.example.com:51820",
    allowedIps: ["0.0.0.0/0", "::/0"],
  },
  errors: [{ field: "mtu", message: "'abc' is not a number." }],
  warnings: [
    "DNS search domain 'home.lan' ignored (only server IPs are used).",
    "PostUp ignored: the userspace tunnel has no network interface or scripts.",
  ],
};

function routes(extra: Parameters<typeof installFetchRoutes>[0] = {}) {
  return installFetchRoutes({
    "GET /api/v1/tunnels/presets": () => presets,
    "POST /api/v1/tunnels/import": () => importResponse,
    "POST /api/v1/tunnels": ({ body }) => ({ status: 201, body: tunnel("t-new", (body as { name: string }).name) }),
    ...extra,
  });
}

describe("TunnelDialog", () => {
  beforeEach(() => {
    setSession({ username: "admin", role: "admin", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  });
  afterEach(() => vi.restoreAllMocks());

  it("imports a .conf, shows field errors and warnings, and creates the tunnel", async () => {
    const { requests } = routes();
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<TunnelDialog tunnel={null} onClose={onClose} />);

    await user.click(await screen.findByRole("radio", { name: /Proton VPN/ }));
    expect(screen.getAllByRole("link", { name: /Where do I get the config/ })[0]).toHaveAttribute(
      "href",
      "https://mullvad.net/en/account/wireguard-config",
    );
    await user.click(screen.getByLabelText(/Paste your WireGuard config/));
    await user.paste(CONF);
    await user.click(screen.getByRole("button", { name: "Parse configuration" }));

    const notes = await screen.findByRole("status", { name: "Import notes" });
    expect(within(notes).getByText(/Mullvad VPN/)).toBeInTheDocument();
    expect(within(notes).getByText(/home\.lan/)).toBeInTheDocument();
    expect(within(notes).getByText(/PostUp ignored/)).toBeInTheDocument();
    expect(requests.find((r) => r.path === "/api/v1/tunnels/import")?.body).toEqual({ text: CONF });

    // The detected preset wins over the picked one, and the import's MTU error opens Advanced.
    expect(screen.getByLabelText("VPN provider")).toHaveValue("mullvad");
    expect(screen.getByLabelText("Name")).toHaveValue("Mullvad VPN");
    expect(screen.getByText("'abc' is not a number.")).toBeInTheDocument();
    expect(screen.getByLabelText("Endpoint")).toHaveValue("vpn.example.com:51820");
    expect(screen.getByLabelText(/^Private key/)).toHaveValue(KEYS.private);

    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Mullvad Stockholm");
    await user.click(screen.getByRole("button", { name: "Save tunnel" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const create = requests.find((r) => r.method === "POST" && r.path === "/api/v1/tunnels");
    expect(create?.body).toEqual({
      name: "Mullvad Stockholm",
      preset: "mullvad",
      enabled: true,
      endpoint: "vpn.example.com:51820",
      addresses: ["10.64.12.3/32"],
      dns: ["10.64.0.1"],
      mtu: null,
      keepalive: null,
      peerPublicKey: KEYS.peer,
      allowedIps: ["0.0.0.0/0", "::/0"],
      privateKey: KEYS.private,
      presharedKey: KEYS.psk,
    });
  });

  it("stays on the provider step when the text is not a WireGuard config", async () => {
    routes({
      "POST /api/v1/tunnels/import": () => ({
        valid: false,
        detectedPreset: "custom",
        tunnel: { name: null, peerPublicKey: null, endpoint: null },
        errors: [
          { field: "interface", message: "No [Interface] section found." },
          { field: "peer", message: "No [Peer] section found." },
        ],
        warnings: [],
      }),
    });
    const user = userEvent.setup();
    renderWithProviders(<TunnelDialog tunnel={null} onClose={() => {}} />);
    await user.click(await screen.findByLabelText(/Paste your WireGuard config/));
    await user.paste("hello world");
    await user.click(screen.getByRole("button", { name: "Parse configuration" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("No [Interface] section found.")).toBeInTheDocument();
    expect(within(alert).getByText("No [Peer] section found.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Parse configuration" })).toBeInTheDocument();
  });

  it("reads an uploaded .conf file into the text area", async () => {
    routes();
    const user = userEvent.setup();
    renderWithProviders(<TunnelDialog tunnel={null} onClose={() => {}} />);
    const file = new File([CONF], "mullvad-se.conf", { type: "text/plain" });
    await user.upload(await screen.findByLabelText("WireGuard configuration file"), file);
    await waitFor(() => expect(screen.getByLabelText(/Paste your WireGuard config/)).toHaveValue(CONF));
  });

  it("validates keys, endpoint, lists and ranges before sending anything", async () => {
    const { requests } = routes();
    const user = userEvent.setup();
    renderWithProviders(<TunnelDialog tunnel={null} onClose={() => {}} />);
    await user.click(await screen.findByRole("radio", { name: /Custom WireGuard/ }));
    await user.click(screen.getByRole("button", { name: /enter the details by hand/ }));

    await user.type(screen.getByLabelText("Name"), "Home");
    await user.type(screen.getByLabelText("Endpoint"), "vpn.example.com:99999");
    await user.type(screen.getByLabelText("Addresses"), "10.0.0.2/40");
    await user.type(screen.getByLabelText("Peer public key"), "not-a-key");
    await user.click(screen.getByRole("button", { name: "Advanced" }));
    await user.type(screen.getByLabelText("MTU"), "9000");
    await user.click(screen.getByRole("button", { name: "Save tunnel" }));

    expect(await screen.findByText("The endpoint port must be between 1 and 65535")).toBeInTheDocument();
    expect(screen.getByText("“10.0.0.2/40” is not an IP address or CIDR")).toBeInTheDocument();
    expect(screen.getByText("The peer public key must be a base64-encoded 32-byte key")).toBeInTheDocument();
    expect(screen.getByText("A private key is required")).toBeInTheDocument();
    expect(screen.getByText(/Custom tunnels need at least one DNS server/)).toBeInTheDocument();
    expect(screen.getByText("MTU must be between 1280 and 1500")).toBeInTheDocument();
    expect(requests.some((r) => r.method === "POST" && r.path === "/api/v1/tunnels")).toBe(false);
  });

  it("maps the server's invalid_tunnel field errors onto the form", async () => {
    routes({
      "POST /api/v1/tunnels": () => ({
        status: 400,
        body: {
          error: {
            code: "invalid_tunnel",
            message: "'endpoint': The endpoint host must be a hostname or IP address.",
            params: { endpoint: "The endpoint host must be a hostname or IP address." },
          },
        },
      }),
    });
    const user = userEvent.setup();
    renderWithProviders(<TunnelDialog tunnel={null} onClose={() => {}} />);
    await user.click(await screen.findByLabelText(/Paste your WireGuard config/));
    await user.paste(CONF);
    await user.click(screen.getByRole("button", { name: "Parse configuration" }));
    await screen.findByRole("status", { name: "Import notes" });
    await user.clear(screen.getByLabelText("MTU"));
    await user.click(screen.getByRole("button", { name: "Save tunnel" }));

    expect(await screen.findByText("The endpoint host must be a hostname or IP address.")).toBeInTheDocument();
  });

  it("keeps stored secrets on edit and shows the device public key", async () => {
    const existing = tunnel("t1", "Mullvad Stockholm", { hasPresharedKey: true });
    const { requests } = routes({ "PUT /api/v1/tunnels/t1": ({ body }) => ({ ...existing, ...(body as object) }) });
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<TunnelDialog tunnel={existing} onClose={onClose} />);

    expect(screen.queryByRole("list", { name: "Steps" })).not.toBeInTheDocument();
    expect(screen.getByText("This device's public key, as the provider sees it")).toBeInTheDocument();
    expect(screen.getByText(KEYS.public)).toBeInTheDocument();
    expect(screen.getAllByText("Stored. Leave empty to keep it.")).toHaveLength(2);

    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Mullvad SE");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const body = requests.find((r) => r.method === "PUT")!.body as Record<string, unknown>;
    expect(body.name).toBe("Mullvad SE");
    expect(body).not.toHaveProperty("privateKey");
    expect(body).not.toHaveProperty("presharedKey");
  });

  it("sends presharedKey \"\" when the stored preshared key is removed", async () => {
    const existing = tunnel("t1", "Mullvad Stockholm", { hasPresharedKey: true });
    const { requests } = routes({ "PUT /api/v1/tunnels/t1": ({ body }) => ({ ...existing, ...(body as object) }) });
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<TunnelDialog tunnel={existing} onClose={onClose} />);

    await user.click(screen.getByLabelText("Remove the stored preshared key"));
    expect(screen.getByLabelText(/^Preshared key/)).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const body = requests.find((r) => r.method === "PUT")!.body as Record<string, unknown>;
    expect(body.presharedKey).toBe("");
    expect(body).not.toHaveProperty("privateKey");
  });
});
