# Built-in VPN tunnels

> **Status: phase 1.** The data model, the `/api/v1/tunnels` API, per-provider and
> per-indexer routing settings, and the fail-closed behaviour are in place. The helper
> process that actually carries traffic (`streamarr-tunnel`) is not shipped yet, so every
> enabled tunnel reports `down` with `lastError: "helper not started yet"` and anything
> routed through a tunnel is unreachable. Phase 2 adds the helper, the real supervisor,
> NNTP/HTTP routing, packaging and the user guide.

Streamarr can hold WireGuard tunnels itself and decide per connection which one to use:
the Usenet provider can stay direct (fastest, nothing sensitive crosses the wire) while
every indexer always goes through a VPN. A tunnel that is not connected makes each
routed connection fail immediately with "VPN down"; Streamarr never falls back to a
direct connection. This replaces the external Gluetun + `INDEXER_PROXY` setup
([setup.md](setup.md)); that option keeps working as a legacy "external proxy" route for
indexers, and a tunnel on an indexer takes precedence over it.

## How it works

- **Userspace WireGuard, no root.** Each enabled tunnel runs as one small helper process
  (`streamarr-tunnel`, Go, built on `golang.zx2c4.com/wireguard` with a netstack TUN) that
  the server spawns and supervises. It needs no TUN device, no `NET_ADMIN`, and works in the
  read-only, `cap_drop: [ALL]` container and later inside the Android app.
- **One SOCKS5 proxy per tunnel** on `127.0.0.1:<port>`, loopback only, no authentication.
  Hostnames are resolved *inside* the tunnel with the tunnel's DNS servers, so indexer and
  provider names never reach the host resolver. Each tunnel gets a fixed port from
  41800–41899 at creation, so pooled NNTP connections simply reconnect after a restart.
- **Routing model.** Every Usenet provider and every indexer has `tunnelId: string | null`
  (`null` = direct). Responses also carry a read-only `route`
  (`kind: direct | tunnel | externalProxy`, `usable`) that reflects the live tunnel state.
- **Fail closed.** Only a `connected` tunnel lets traffic through. `disabled`, `starting`,
  `degraded` and `down` make routed connections fail at once with
  `TunnelUnavailableException` ("VPN down"), shown as `errorCode: "vpn_down"` by the
  provider/indexer **Test** buttons, as `vpn_down` components in the diagnostics report,
  and as "VPN down" in deep health.
- **Always direct by design:** TMDB metadata, notifications (Pushover, e-mail) and
  Jellyfin. Only Usenet (NNTP) and indexer traffic (Newznab API, NZB downloads) is routed.
- **Secrets.** The private key and the optional preshared key are encrypted at rest with
  ASP.NET Data Protection exactly like provider passwords. The API never returns them; it
  returns `hasPrivateKey`, `hasPresharedKey` and the derived WireGuard public key
  (X25519 per RFC 7748) so you can compare it with what the provider shows.

## Adding a tunnel

1. Generate a WireGuard configuration at your provider (the preset catalog at
   `GET /api/v1/tunnels/presets` links to the right page for Mullvad, Proton VPN, NordVPN,
   Surfshark, Private Internet Access, AirVPN, Windscribe and IVPN; anything else is
   "Custom WireGuard").
2. Import the `.conf` text with `POST /api/v1/tunnels/import`. The answer is a prefilled
   tunnel plus per-field errors and warnings (ignored `PostUp` scripts, DNS search domains,
   a second peer). The preset is detected from the endpoint host or the provider's
   in-tunnel DNS server.
3. Name it and save it with `POST /api/v1/tunnels`. DNS defaults to the preset's servers;
   AllowedIPs default to `0.0.0.0/0, ::/0`.
4. Set `tunnelId` on the indexers (and, if you want, providers) that must use it, then use
   their **Test** buttons. While the tunnel is down they answer `vpn_down`.

Deleting a tunnel that providers or indexers still use returns `409 tunnel_in_use` with
their names; `DELETE …?force=true` sets them back to direct first.

## Management UI

- **VPN page** (`/vpn`, between Usenet Providers and Quality Profiles). One card per
  tunnel: a status pill (`Connected` green with exit IP, latency and handshake age,
  `Connecting` pulsing, `Degraded` amber with the reason, `Down` red with `lastError`,
  `Disabled` grey), preset, endpoint, addresses, DNS, received/sent bytes, the derived
  device public key (copy button) and "Used by" chips. Each card has an enable switch,
  **Test** (handshake, exit IP and latency inline), edit and delete. The page polls
  `GET /tunnels/status` every 5 s and merges it into the cards.
- **Add tunnel** is two steps. *Provider*: pick a preset (each links to the page where the
  provider generates a WireGuard config) and paste, upload or drop the `.conf`; **Parse**
  calls `POST /tunnels/import`. The file is read in the browser and sent only to Streamarr.
  *Details*: the prefilled form with the import's warnings and per-field errors; a preset
  detected from the config replaces the picked one. MTU, keepalive and AllowedIPs sit under
  *Advanced*. "Skip import" opens an empty form. The form checks what the API checks
  (32-byte base64 keys, `host:port`, IP/CIDR lists, MTU 1280–1500, keepalive 0–600, DNS for
  custom tunnels); `400 invalid_tunnel` field messages land on the matching fields.
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

## Limitations (this iteration)

- WireGuard only; no OpenVPN.
- No provider account APIs or server lists: every tunnel is configured from a `.conf`
  the provider generated. Account-based setup is a follow-up.
- At most 100 tunnels (one fixed loopback port each).
- TMDB, notifications and Jellyfin cannot be routed.

## Decisions made while implementing

- `presharedKey: ""` on update removes the preshared key; omitting either secret keeps
  it. `tunnelId: ""` on a provider or indexer means "direct", omitting it keeps the
  current value.
- The custom preset has no default DNS, so a custom tunnel must name at least one DNS
  server (hostnames must resolve inside the tunnel).
- A tunnel's fixed SOCKS5 port is stored with the tunnel (`LocalPort`, not exposed in the
  API) and reused across restarts; two concurrent creates that pick the same port are
  retried, the unique index decides.
- Disabled tunnels are not diagnostics components (they are intentionally off); routed
  dependencies still show `vpn_down`. Hints: `tunnel_down` when every enabled tunnel is
  down, `some_tunnels_down` otherwise, listed before the provider/indexer hints because
  they explain them. Tunnels do not join the viewer service-status categories; the routed
  providers and indexers already do.
- The provider speed test refuses a routed provider whose tunnel is down with
  `503 vpn_down` instead of measuring a direct connection.
- Preset detection is best effort (endpoint host fragments, then well-known DNS such as
  Mullvad's `10.64.0.1`); the user can change the preset.
- Phase 1 runs a placeholder supervisor: it never starts a helper and reports every
  enabled tunnel as `down`. Providers and indexers with a `tunnelId` are therefore marked
  unreachable in diagnostics and tests, while the live NNTP pool and Newznab client still
  connect directly until phase 2 wires the routes. Do not ship phase 1 on its own.

## API

See [api.md](api.md#tunnels--apiv1tunnels) for the endpoint and payload reference.
