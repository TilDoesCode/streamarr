# streamarr-tunnel

A small Go helper that runs one userspace WireGuard tunnel (wireguard-go with a gVisor netstack,
no TUN device, no root, no `NET_ADMIN`) and exposes it to the Streamarr server as a loopback
SOCKS5 proxy. The server starts one helper per enabled tunnel and supervises it
([docs/vpn.md](../../docs/vpn.md)). Pure Go, `CGO_ENABLED=0`, so the same source builds a static
Linux binary for the container and an Android arm64 binary for the app bundle.

## Invocation

```
streamarr-tunnel [-validate] [-version]
```

The helper reads **one JSON document from stdin** (secrets never appear on argv or in the
environment), then keeps running until stdin is closed by the parent or it receives
`SIGTERM`/`SIGINT`. `-validate` only validates the config and exits; `-version` prints the
version embedded by `build.sh`.

### Config (stdin)

| Field | Type | Meaning |
|---|---|---|
| `privateKey` | base64 | Interface private key (32 bytes). Required. |
| `peerPublicKey` | base64 | The VPN server's public key. Required. |
| `presharedKey` | base64 | Optional preshared key. |
| `endpoint` | `host:port` | Peer endpoint. A hostname is resolved **once at start with the host resolver** (the VPN server's own name is the only name that legitimately resolves outside the tunnel); IPv4 is preferred. Required unless `listenPort` is set. |
| `listenPort` | int | UDP listen port (server/test mode). Default 0 = random. |
| `addresses` | string[] | Interface addresses (`10.64.12.3/32`, bare addresses get a host mask). Required. |
| `dns` | string[] | DNS servers **inside the tunnel**. Hostnames handed to the SOCKS proxy are resolved only through these; with none configured, every name fails (never the host resolver). |
| `mtu` | int | 1280–65535, default 1420. |
| `keepalive` | int | PersistentKeepalive seconds, 0 = off. |
| `allowedIps` | string[] | Peer AllowedIPs CIDRs. Required. |
| `socksPort` | int | SOCKS5 port on 127.0.0.1; 0 = ephemeral (reported on the ready line). |
| `socksDisabled` | bool | No SOCKS listener (server/test mode). |
| `statusPort` | int | Status HTTP port on 127.0.0.1; 0 = ephemeral. |
| `exitCheckUrl` | URL | Fetched through the tunnel by `/exit`; default `https://api.ipify.org?format=json`. Must answer `{"ip":"…"}` or a bare address. |
| `forwards` | `[{listen, target}]` | Test/server mode: listen on `listen` (ip:port) inside the tunnel and pipe to `target` (host:port) on the host. |
| `dnsRecords` | `{name: ip}` | Test/server mode: answer A/AAAA for these names on port 53 of the first interface address. |
| `logLevel` | `"verbose"` | Also log WireGuard debug lines. |

Validation errors name the field: `{"level":"error","msg":"invalid config","field":"privateKey","error":"…"}`.

### stdout

Exactly one line once every listener accepts:

```json
{"event":"ready","socksPort":41800,"statusPort":41900,"endpoint":"203.0.113.5:51820"}
```

### stderr

One JSON object per line: `{"ts":"…","level":"info|warn|error|debug","msg":"…", …}`. The
server keeps the last `error` line as the tunnel's `lastError` when the process exits.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | stopped normally (stdin closed or signal) |
| 2 | invalid config |
| 3 | could not start (endpoint resolution, port already bound, WireGuard rejected the config) |
| 4 | the WireGuard device stopped unexpectedly |

## SOCKS5 proxy (`127.0.0.1:<socksPort>`)

RFC 1928 subset: version 5, "no authentication" only (clients offering nothing else get `0xFF`),
`CONNECT` only (`0x07` otherwise), address types IPv4 (`0x01`), domain name (`0x03`) and IPv6
(`0x04`). Domain names are resolved by the netstack through the tunnel's `dns` servers. Reply
codes: `0x00` success (zero bind address), `0x05` connection refused, `0x04` host unreachable
(including every DNS failure), `0x03` network unreachable, `0x01` other failure.

## Status endpoint (`127.0.0.1:<statusPort>`)

`GET /status`

```json
{"socksPort":41800,"statusPort":41900,"endpoint":"203.0.113.5:51820","listenPort":53112,
 "startedAtUtc":"2026-11-02T21:17:38Z","uptimeSeconds":12.5,
 "lastHandshakeUtc":"2026-11-02T21:17:39Z","handshakeAgeSeconds":11.2,
 "rxBytes":1234,"txBytes":5678,"lastError":null}
```

`lastHandshakeUtc`/`handshakeAgeSeconds` are `null` until the first handshake. `lastError` is
`"handshake timeout: no handshake with <endpoint> after Ns"` once the tunnel ran 30 s without a
handshake, `"handshake stale: last handshake with <endpoint> Ns ago"` when the last one is older
than 3 minutes, otherwise the last internal error or `null`.

`GET /exit` fetches `exitCheckUrl` through the tunnel (no redirects, 20 s budget):

```json
{"ok":true,"ip":"203.0.113.77","latencyMs":184.2,"url":"https://api.ipify.org?format=json"}
{"ok":false,"latencyMs":20001.3,"url":"…","error":"exit check failed: …"}
```

`GET /healthz` answers `204`.

## Build

```bash
./build.sh                 # host build -> dist/host/streamarr-tunnel (picked up by dotnet build)
./build.sh linux-amd64 linux-arm64 android-arm64
./build.sh all
go test ./...              # unit tests + a real two-tunnel WireGuard round trip over loopback UDP
```

Builds are `CGO_ENABLED=0 -trimpath -ldflags "-s -w -buildid="`, so the same source and
toolchain produce identical bytes. `android-arm64` uses `GOOS=android` and yields
`libstreamarr-tunnel.so`, a PIE whose only runtime dependency is Android's own
`/system/bin/linker64` (Go cannot emit `-buildmode=exe` for android/arm64). The static
`linux-arm64` binary also runs on Android if a non-PIE file is preferred.

The toolchain is pinned in `go.mod` (`go`/`toolchain` directives); `server/Dockerfile` builds
the helper in a `golang` stage and copies it next to `Streamarr.Server.dll`.

## Licenses

wireguard-go (MIT), gVisor (Apache-2.0), golang.org/x packages (BSD-3-Clause); see the repository
`NOTICE`.
