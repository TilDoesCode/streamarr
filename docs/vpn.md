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
  tunnel. TMDB, notifications (Pushover, email) and Jellyfin stay direct by design: they
  carry no Usenet traffic and must keep working while a VPN is down.
- **Fail closed.** Only a `connected` tunnel hands out its proxy. Any other state makes
  routed connections fail at once with a clear "VPN down" error, visible in the provider
  and indexer **Test** results (`errorCode: "vpn_down"`), in search outcomes, in the
  diagnostics report and in deep health. Pooled NNTP connections reconnect through the
  tunnel after the helper restarts.

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
2. In the management UI open **Tunnels**, paste or drop the `.conf`, and let the import fill
   in the form (`POST /api/v1/tunnels/import` reports a problem per field). Give the tunnel a
   name and save. The private key and preshared key are encrypted at rest exactly like
   provider passwords and are never returned by the API; the derived public key is shown so
   you can compare it with the key registered at your provider.
3. Wait for `connected`, then press **Test**: it reports the handshake, the exit IP seen
   through the tunnel and the round trip.
4. Open each indexer (and, if you want, provider) and pick the tunnel under **Route**. The
   list shows the live route (`direct`, `tunnel`, `externalProxy`) and whether it is usable.

Use `GET /api/v1/tunnels/status` for cheap polling of all tunnel states; `GET /api/v1/tunnels`
adds config and which providers/indexers use each tunnel. Deleting a tunnel that is still in
use answers `409 tunnel_in_use` unless `?force=true`, which sets its users back to direct.

## Migrating from Gluetun

1. Create a tunnel from the same WireGuard `.conf` you gave Gluetun and wait for
   `connected`.
2. Set every indexer's route to the tunnel. Providers usually stay direct.
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
  the tunnel's public key is the one registered at the provider (compare `publicKey` in the
  tunnel view). Many providers rotate or revoke device keys; re-import a fresh `.conf`.
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
- TMDB, notifications and Jellyfin traffic always leave directly.
- Port forwarding for incoming connections is not needed and not supported.

## Decisions (phase 1 and 2)

- Userspace WireGuard in a separate Go helper, not in-process, so the server needs no
  native dependencies and the Android app can ship the same binary.
- One fixed loopback SOCKS5 port per tunnel so pooled connections simply reconnect after a
  helper restart; the status endpoint is port + 100.
- `connected` requires a successful exit-IP check, not just a handshake, because a
  handshake alone does not prove traffic flows.
- Routing is resolved per new connection and never falls back; a disabled or broken tunnel
  is a hard error ("VPN down"), not a silent direct connection.
- `INDEXER_PROXY` remains as a legacy external-proxy route for indexers only.
