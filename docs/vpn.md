# Built-in VPN tunnels

Streamarr can hold WireGuard tunnels itself and decide **per connection** which one to use:
the Usenet provider can stay direct (fastest, nothing sensitive crosses the wire) while every
indexer always goes through a VPN. A tunnel that is not connected makes each routed
connection fail immediately with "VPN down"; Streamarr never falls back to a direct
connection. This replaces the external Gluetun + `INDEXER_PROXY` setup ([setup.md](setup.md));
that option keeps working as a legacy "external proxy" route for indexers, and a tunnel on an
indexer takes precedence over it.

## How it works

- **Userspace WireGuard, no root.** Each enabled tunnel runs as one small helper process,
  `streamarr-tunnel` (Go, built on wireguard-go with a gVisor netstack), that the server
  starts and supervises. It needs no TUN device and no `NET_ADMIN`, so it works in the
  shipped read-only, `cap_drop: [ALL]` container and inside the Android app. Source and
  protocol: [`server/tunnel/README.md`](../server/tunnel/README.md).
- **One SOCKS5 proxy per tunnel** on `127.0.0.1:<port>`, loopback only, no authentication.
  Hostnames are resolved *inside* the tunnel with the tunnel's DNS servers, so indexer and
  provider names never reach the host resolver. Each tunnel gets a fixed port from
  41800–41899 at creation; the helper's status endpoint uses that port + 100.
- **Routing model.** Every Usenet provider and every indexer has `tunnelId: string | null`
  (null = direct). NNTP connections go TCP → SOCKS5 CONNECT (provider host as a domain
  name) → the usual TLS/plain NNTP flow, with TLS still validated against the provider's
  name. Newznab capability checks, searches and NZB downloads use a `socks5://` handler per
  tunnel. Responses also carry a read-only `route` (`kind: direct | tunnel | externalProxy`,
  `usable`) that reflects the live tunnel state. TMDB, notifications (Pushover, email) and
  Jellyfin stay direct by design: they carry no Usenet traffic and must keep working while a
  VPN is down.
- **Fail closed.** Only a `connected` tunnel hands out its proxy. Any other state makes
  routed connections fail at once with a clear "VPN down" error, visible in the provider
  and indexer **Test** results (`errorCode: "vpn_down"`), in the provider speed test
  (`503 vpn_down`), in search outcomes, in the diagnostics report and in deep health. Pooled
  NNTP connections reconnect through the tunnel after the helper restarts.
- **Secrets.** The private key and the optional preshared key are encrypted at rest with
  ASP.NET Data Protection exactly like provider passwords, handed to the helper over stdin
  only, and never returned by the API: it reports `hasPrivateKey`, `hasPresharedKey` and the
  derived WireGuard public key so you can compare it with the key registered at your provider.

### Tunnel states

| State | Meaning | Routed traffic |
|---|---|---|
| `disabled` | Switched off by you | refused |
| `starting` | Helper running, waiting for the first handshake and exit check | refused |
| `connected` | Fresh handshake and the exit-IP check succeeded through the tunnel | allowed |
| `degraded` | Last handshake older than 3 minutes, or the exit check failed | refused |
| `down` | No handshake within 30 s, helper exited or unreachable, helper binary missing, tunnels switched off | refused |

The supervisor polls each helper every 10 s, re-checks the exit IP every 10 minutes and
restarts a crashed helper with exponential backoff (2 s … 60 s). `lastError` always says
why a tunnel is not connected, for example
`handshake timeout: no handshake with 203.0.113.5:51820 after 31s`.

## Adding a tunnel

1. Download a WireGuard configuration from your provider. Presets with help links exist for
   Mullvad, ProtonVPN, NordVPN (NordLynx), Surfshark, Private Internet Access, AirVPN,
   Windscribe and IVPN; anything else is "Custom WireGuard". NordVPN does not offer `.conf`
   downloads; use a third-party generator or the custom preset.
2. In the management UI open **VPN** and press **Add tunnel**. Pick the provider, paste,
   upload or drop the `.conf`, and press **Parse configuration**: the import
   (`POST /api/v1/tunnels/import`) fills in the form and reports a problem per field. Give
   the tunnel a name and save. The private key and preshared key are encrypted at rest and
   never shown again; the derived public key is shown on the card so you can compare it with
   the key registered at your provider.
3. Wait for `Connected`, then press **Test**: it reports the handshake, the exit IP seen
   through the tunnel and the round trip.
4. Open each indexer (and, if you want, provider) and pick the tunnel under **Connection**.
   The rows then show the live route as a badge (`Direct`, `via <tunnel>`, `External proxy`)
   and whether it is usable.

Use `GET /api/v1/tunnels/status` for cheap polling of all tunnel states; `GET /api/v1/tunnels`
adds config and which providers/indexers use each tunnel. Deleting a tunnel that is still in
use answers `409 tunnel_in_use` unless `?force=true`, which sets its users back to direct.
Endpoint and payload reference: [api.md](api.md#tunnels--apiv1tunnels).

## Management UI

- **VPN page** (`/vpn`, between Usenet Providers and Quality Profiles). One card per
  tunnel: a status pill (`Connected` green with exit IP, latency and handshake age,
  `Connecting` pulsing, `Degraded` amber with the reason, `Down` red with `lastError`,
  `Disabled` grey), preset, endpoint, addresses, DNS, received/sent bytes, the derived
  device public key (copy button) and "Used by" chips. Each card has an enable switch,
  **Test** (handshake, exit IP and latency inline), edit and delete. The page polls
  `GET /tunnels/status` every 5 s and merges it into the cards.
- **Add tunnel** is two steps. *Provider*: pick a preset (each links to the page where the
  provider generates a WireGuard config) and paste, upload or drop the `.conf`;
  **Parse configuration** calls `POST /tunnels/import`. The file is read in the browser and
  sent only to Streamarr. *Details*: the prefilled form with the import's warnings and
  per-field errors; a preset detected from the config replaces the picked one. MTU,
  keepalive and AllowedIPs sit under *Advanced*. "Skip import and enter the details by hand"
  opens an empty form. The form checks what the API checks (32-byte base64 keys,
  `host:port`, IP/CIDR lists, MTU 1280–1500, keepalive 0–600, DNS for custom tunnels);
  `400 invalid_tunnel` field messages land on the matching fields.
- **Editing** never shows secrets: empty key fields keep the stored keys, "Remove the stored
  preshared key" sends `presharedKey: ""`.
- **Deleting** a tunnel still in use shows the providers and indexers from
  `409 tunnel_in_use` and offers **Set them to direct and delete** (`?force=true`).
- **Providers and indexers** have a *Connection* select in their edit dialogs: "Direct
  (default)" or "via <tunnel> – <state>"; without tunnels it links to the VPN page. Each
  row carries a route badge: `Direct`, `via <tunnel>` (green, connected), `via <tunnel> ·
  VPN down` (red, any other state; the tooltip has the reason) or `External proxy` (legacy
  `INDEXER_PROXY`, indexers only). Badges use the live tunnel state when the tunnel list is
  loaded.
- **`vpn_down`** means the routed tunnel is not connected, so Streamarr sent nothing.
  Provider/indexer **Test** results and the provider speed test (`503 vpn_down`) say
  "Tunnel “<name>” is not connected; nothing is sent until it is." with a link to the VPN
  page, instead of a generic connection error.
- **Dashboard** shows a VPN tile (connected / down / off counts and a pill per tunnel) once
  a tunnel exists. **Diagnostics** explains `tunnel_down` and `some_tunnels_down`, lists
  tunnels as "VPN tunnel" components and labels `vpn_down` as "VPN down (nothing sent)".

## Migrating from Gluetun

1. Create a tunnel from the same WireGuard `.conf` you gave Gluetun and wait for
   `Connected`.
2. Set every indexer's **Connection** to the tunnel. Providers usually stay direct.
3. Remove `INDEXER_PROXY` from `.env` and the Gluetun service from your Compose file. While
   both exist, a tunnel on an indexer wins over the external proxy; indexers without a tunnel
   keep using `INDEXER_PROXY`.

## Options and packaging

| Setting | Default | Purpose |
|---|---|---|
| `Streamarr:Tunnels:Enabled` (`Streamarr__Tunnels__Enabled`) | `true` | `false` keeps every tunnel `down` without starting helpers; routed traffic still fails closed |
| `Streamarr:Tunnels:HelperPath` | next to `Streamarr.Server.dll`, then `<ContentRoot>/tunnel/streamarr-tunnel` | Where the helper binary is |
| `Streamarr:Tunnels:PollIntervalSeconds` | `10` | Status poll interval |
| `Streamarr:Tunnels:HandshakeTimeoutSeconds` | `30` | No first handshake → `down` |
| `Streamarr:Tunnels:HandshakeStaleSeconds` | `180` | Handshake age → `degraded` (WireGuard rekeys every 2 minutes under traffic) |
| `Streamarr:Tunnels:ExitCheckIntervalSeconds` | `600` | Exit-IP re-check while connected |
| `Streamarr:Tunnels:ExitCheckUrl` | preset URL or `https://api.ipify.org?format=json` | Override the exit-IP check (air-gapped labs) |

The Docker image builds the helper in a Go stage and ships it next to the server for
amd64 and arm64. For a native dev setup run `server/scripts/build-tunnel-helper.sh`
once (needs Go; see `server/tunnel/go.mod` for the version): it writes
`server/tunnel/dist/host/streamarr-tunnel`, which `dotnet build` copies next to the server
and test assemblies. `server/tunnel/build.sh` cross-builds `linux-amd64`, `linux-arm64`,
`android-arm64` (`libstreamarr-tunnel.so` for the Android app bundle) and more. Without the
binary the server still starts; every enabled tunnel is `down` with
`lastError: helper binary not found (looked for …)`.

## Troubleshooting

- **`starting` forever, then `down` with "handshake timeout".** The endpoint is unreachable
  or the keys do not match. Check the endpoint host/port, that UDP is not blocked, and that
  the tunnel's public key is the one registered at the provider (compare the device public
  key on the tunnel card). Many providers rotate or revoke device keys; re-import a fresh
  `.conf`.
- **`connected` briefly, then `degraded` with "exit check failed".** The handshake works but
  no traffic flows: wrong `AllowedIPs` (use `0.0.0.0/0, ::/0`), a provider-side kill switch,
  or an MTU too large for the path. Try `mtu: 1280`.
- **Indexer tests fail with "host unreachable" or name-resolution errors while the tunnel is
  `connected`.** The tunnel's DNS servers are wrong or missing; names are only resolved
  inside the tunnel. Use the DNS from the provider's `.conf` (Mullvad `10.64.0.1`, Proton
  `10.2.0.1`, …).
- **`degraded` with "handshake stale".** No handshake for over 3 minutes: the server stopped
  answering or the path changed. WireGuard retries on its own; the tunnel returns to
  `connected` after the next handshake and exit check. Set a `keepalive` (25 s) behind NAT.
- **`down` with "helper exited with code 2"** — the helper rejected the configuration; the
  message names the field. **Code 3** — it could not start (port in use, endpoint name does
  not resolve). Loopback ports 41800–41999 must be free on the host.
- **`down` with "tunnels are switched off"** — `Streamarr:Tunnels:Enabled=false`.

## Limitations

- WireGuard only (no OpenVPN). No provider account APIs or server lists yet: you bring a
  `.conf`, presets only supply help links, defaults and the exit-IP check URL.
- One peer per tunnel, IPv4 and IPv6 inside the tunnel, UDP endpoint only.
- At most 100 tunnels (one fixed loopback port each).
- TMDB, notifications and Jellyfin traffic always leave directly.
- Port forwarding for incoming connections is not needed and not supported.

## Decisions

- Userspace WireGuard in a separate Go helper, not in-process, so the server needs no
  native dependencies and the Android app can ship the same binary.
- One fixed loopback SOCKS5 port per tunnel so pooled connections simply reconnect after a
  helper restart; the status endpoint is port + 100. The port is stored with the tunnel
  (`LocalPort`, not exposed in the API) and reused across restarts; two concurrent creates
  that pick the same port are retried, the unique index decides.
- `connected` requires a successful exit-IP check, not just a handshake, because a
  handshake alone does not prove traffic flows.
- Routing is resolved per new connection and never falls back; a disabled or broken tunnel
  is a hard error ("VPN down"), not a silent direct connection. The provider speed test
  refuses a routed provider whose tunnel is down with `503 vpn_down` instead of measuring a
  direct connection.
- `INDEXER_PROXY` remains as a legacy external-proxy route for indexers only.
- `presharedKey: ""` on update removes the preshared key; omitting either secret keeps it.
  `tunnelId: ""` on a provider or indexer means "direct", omitting it keeps the current value.
- The custom preset has no default DNS, so a custom tunnel must name at least one DNS
  server (hostnames must resolve inside the tunnel).
- Disabled tunnels are not diagnostics components (they are intentionally off); routed
  dependencies still show `vpn_down`. Hints: `tunnel_down` when every enabled tunnel is
  down, `some_tunnels_down` otherwise, listed before the provider/indexer hints because
  they explain them. Tunnels do not join the viewer service-status categories; the routed
  providers and indexers already do.
- Preset detection is best effort (endpoint host fragments, then well-known DNS such as
  Mullvad's `10.64.0.1`); the user can change the preset.
