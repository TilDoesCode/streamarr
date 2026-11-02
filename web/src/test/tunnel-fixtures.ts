import type { TunnelPresetResponse, TunnelResponse, TunnelStatus } from "@/api/types";

export const KEYS = {
  private: "Z6oi7H2za6MjMwPT36Ku4z/lRdgma93CqaRk4RBym8U=",
  peer: "4lWFoXFaZOG/ss35101ZbHXPbLR9DgVeNekWLSXLvik=",
  psk: "bsNrm6ZsGASP7Up0t6XcbGpC+xotAvmc4FQJSKfg4Oc=",
  public: "ejQePntNgpAqmzz+ICy+92/jmp+bvw8MwWOj5oJSL0k=",
};

export const presets: TunnelPresetResponse[] = [
  {
    id: "mullvad",
    name: "Mullvad VPN",
    helpUrl: "https://mullvad.net/en/account/wireguard-config",
    defaultDns: ["10.64.0.1"],
    defaultEndpointPort: 51820,
    hint: "Generate a WireGuard configuration in your Mullvad account and import the .conf file.",
  },
  {
    id: "protonvpn",
    name: "Proton VPN",
    helpUrl: "https://account.protonvpn.com/downloads#wireguard-configuration",
    defaultDns: ["10.2.0.1"],
    defaultEndpointPort: 51820,
    hint: "Create a WireGuard configuration under Downloads in your Proton account and import it.",
  },
  {
    id: "custom",
    name: "Custom WireGuard",
    helpUrl: "https://www.wireguard.com/quickstart/",
    defaultDns: [],
    defaultEndpointPort: 51820,
    hint: "Any WireGuard peer. DNS servers are required.",
  },
];

const since = new Date(Date.now() - 180_000).toISOString();

export function status(state: string, extra: Partial<TunnelStatus> = {}): TunnelStatus {
  return { state, since, rxBytes: null, txBytes: null, lastError: null, ...extra };
}

export function tunnel(id: string, name: string, extra: Partial<TunnelResponse> = {}): TunnelResponse {
  return {
    id,
    name,
    preset: "mullvad",
    enabled: true,
    endpoint: "se-sto-wg-001.relays.mullvad.net:51820",
    addresses: ["10.64.12.3/32"],
    dns: ["10.64.0.1"],
    mtu: null,
    keepalive: 25,
    peerPublicKey: KEYS.peer,
    hasPrivateKey: true,
    publicKey: KEYS.public,
    hasPresharedKey: false,
    allowedIps: ["0.0.0.0/0", "::/0"],
    status: status("down", { lastError: "helper not started yet" }),
    usedBy: { providers: [], indexers: [] },
    ...extra,
  };
}

export const connectedTunnel = tunnel("t-conn", "Mullvad Stockholm", {
  status: status("connected", {
    exitIp: "185.65.134.86",
    latencyMs: 38,
    lastHandshakeUtc: new Date(Date.now() - 12_000).toISOString(),
    rxBytes: 1_572_864_000,
    txBytes: 52_428_800,
  }),
  usedBy: {
    providers: [{ id: "p1", name: "Eweka" }],
    indexers: [
      { id: "i1", name: "NZBGeek" },
      { id: "i2", name: "DrunkenSlug" },
      { id: "i3", name: "NZBFinder" },
    ],
  },
});
