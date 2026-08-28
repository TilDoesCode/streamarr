# Operations

This guide covers the routine work after Streamarr is installed: safe access, health
checks, logs, upgrades, backups, and removal.

## Everyday commands

Run these from the directory containing `compose.yml` and `.env`:

```bash
# Service and health status
docker compose ps

# Recent Core logs
docker compose logs --tail=100 streamarr

# Follow new Core logs
docker compose logs -f --tail=100 streamarr

# Stop without deleting persistent data
docker compose down

# Start again
docker compose up -d
```

If you use the bundled Jellyfin service, include `--profile jellyfin` when starting,
stopping, or inspecting the complete stack, for example
`docker compose --profile jellyfin down`.

The management UI also has a sanitized **Logs** view plus stream-specific diagnostics.
Use container logs when the process cannot start or the UI is unreachable.

## Network access

Streamarr serves HTTP on container port `8080`. Only that inbound Core port is needed;
indexer, TMDB, and NNTP connections are outbound.

### Same machine

The default `127.0.0.1:8080` bind is the safest option. Open
`http://127.0.0.1:8080` on the Docker host.

For temporary access to a remote home server, an SSH tunnel preserves that safe bind:

```bash
ssh -L 8080:127.0.0.1:8080 user@your-server
```

Then open `http://127.0.0.1:8080` on your computer.

### Trusted home LAN

With the official Compose file, set `STREAMARR_BIND_ADDRESS` in `.env` to the server's
exact private address, such as `192.168.1.20`. With the README's minimal Compose file,
replace the host side of the port mapping:

```yaml
ports:
  - "192.168.1.20:8080:8080"
```

Allow the port only from trusted LAN clients in the host firewall. If Jellyfin uses an
internal Core URL, set the plugin's **Public stream URL** to this client-reachable LAN
address. Do not use a public interface as a shortcut.

### Reverse proxy and HTTPS

For regular remote access, keep Streamarr on loopback or a private container network
and terminate HTTPS at a trusted reverse proxy or VPN ingress. A proxy on the same host
can forward to `127.0.0.1:8080`.

If the proxy reaches Streamarr from a different container or host, use the release
bundle's `compose.proxy.yml` overlay. In `.env`:

```dotenv
COMPOSE_FILE=compose.yml:compose.proxy.yml
STREAMARR_TRUSTED_PROXY=172.18.0.2
STREAMARR_TRUSTED_ORIGIN=https://streamarr.example.com
```

The overlay configures forwarding-header and browser-origin trust; it does not make a
loopback-bound port reachable. Also choose one private transport:

- set `STREAMARR_BIND_ADDRESS` to the Docker host's exact private IP and restrict that
  port in the firewall to the proxy host; or
- attach Streamarr and the proxy to one private Docker network and proxy to
  `http://streamarr:8080` without publishing the Core port on a public interface.

Use the proxy's exact source IP, not an entire subnet. The trusted origin is the
browser-visible scheme and host, with no path. Incorrect values can either reject
legitimate browser changes or trust forged forwarding headers.

Stream URLs contain short-lived capabilities. Configure proxy access logs to avoid
recording query strings and identifiers on stream, session, playback-admission, and
ephemeral-file paths. Never publish the Core's plain HTTP port directly to the internet.

## Health and diagnostics

`docker compose ps` uses the anonymous shallow endpoint
`GET /api/v1/health?deep=false`. It confirms that the process, web server, and database
migrations started. It does not contact your external services.

For real readiness:

1. use **Test** on every enabled provider and indexer;
2. confirm title discovery works with TMDB;
3. resolve and preview a browser-compatible release (the preview does not transcode); and
4. only then test the Jellyfin plugin.

The Dashboard summarizes dependency health, active streams, connection use, and
throughput. **Streams** keeps the playback history and per-attempt diagnostics;
**Repairs** shows PAR2 work and artifacts.

## Upgrade

Read the [release notes](https://github.com/TilDoesCode/streamarr/releases) and create a
backup first. Core database migrations run automatically when the new container starts.

### Release-bundle installation

Download and extract the newer `streamarr-home-<version>.tar.gz` into the installation
directory. Keep your existing `.env`; the archive contains only `.env.example`. The new
bundle replaces the Compose definitions and bundled plugin with matching versions.

Then run:

```bash
docker compose pull
docker compose up -d
docker compose ps
```

If you use the bundled Jellyfin profile, update and recreate that service too:

```bash
docker compose --profile jellyfin pull
docker compose --profile jellyfin up -d --force-recreate jellyfin
docker compose --profile jellyfin ps
```

The explicit Jellyfin recreate reloads the updated plugin files from the bundle's bind
mount; Compose cannot detect a DLL content change on its own.

### Minimal `latest` installation

```bash
docker compose pull
docker compose up -d
```

For predictable upgrades, replace `latest` with a complete release tag such as
`0.14.0`. The release bundle already pins that value for you.

After every upgrade, check Core health and test one browser preview. If you use
an existing Jellyfin server, update the Streamarr plugin from its catalog and restart
Jellyfin. In either deployment, confirm that Core and plugin versions match and that
Jellyfin itself remains on a supported version.

Rolling back after a database migration requires the matching older image, plugin, and
pre-upgrade data/key backup. Merely changing the image tag may leave an older Core
reading a newer database schema.

## Back up

Back up these named volumes together while Streamarr is stopped:

- `streamarr_streamarr-data` — database, configuration, and persistent caches;
- `streamarr_streamarr-keys` — the keys needed to decrypt stored secrets.

Confirm the exact names with `docker volume ls` if the Compose project name was changed.

One simple stopped-volume backup is:

```bash
docker compose down
mkdir -p backup
docker run --rm \
  -v streamarr_streamarr-data:/source:ro \
  -v "$PWD/backup:/backup" \
  alpine:3.22 tar -C /source -czf /backup/streamarr-data.tar.gz .
docker run --rm \
  -v streamarr_streamarr-keys:/source:ro \
  -v "$PWD/backup:/backup" \
  alpine:3.22 tar -C /source -czf /backup/streamarr-keys.tar.gz .
cp .env backup/.env
docker compose up -d
```

Store the backup away from the Docker host and protect it like a password vault. It
contains encrypted service credentials plus the keys that decrypt them.

Restore both archives into empty volumes with the matching Compose/image version while
the service is stopped. Never restore only the database without its matching key ring.
NZB, pre-download, and repair data are caches, but keeping the whole data volume is the
least surprising recovery path.

## Stop or remove Streamarr

Stop the containers while preserving data:

```bash
docker compose down
```

`docker compose down -v` permanently deletes the database, key ring, settings, and
caches. Use it only when you intentionally want to remove the installation and have a
backup if recovery matters.

For the bundled Jellyfin profile, use `docker compose --profile jellyfin down` to stop
the complete stack. Add `-v` only when you also intend to delete the bundled Jellyfin
configuration and cache volumes.

An existing Jellyfin plugin must be uninstalled separately from Jellyfin's dashboard.

## Troubleshooting

| Symptom | Check |
|---|---|
| Compose says a required variable is missing | Ensure `.env` is beside `compose.yml`, both secrets are non-empty, and the machine key has at least 32 characters |
| Container starts but login fails after changing `.env` | The environment password only bootstraps an empty database; use the saved password or reset it from the UI |
| Core is healthy but searches are empty | Test the indexer, check its categories, and verify the TMDB credential |
| Provider test fails | Confirm NNTP host, TLS/port, credentials, account connection limit, and outbound firewall access |
| Jellyfin cannot test the Core connection | Use an address reachable from the Jellyfin server; `127.0.0.1` inside a Jellyfin container points to Jellyfin itself, not Streamarr |
| Jellyfin finds an item but a TV/phone cannot play it | Set **Public stream URL** to the HTTPS or private-LAN Core address reachable by that device |
| Browser changes fail with `403 csrf_rejected` behind a proxy | Configure the exact trusted proxy IP and browser-visible trusted origin through the proxy overlay |
| Native Jellyfin search works but Streamarr results disappear | Check Core/plugin versions and Core reachability; interception intentionally falls back when its deadline or compatibility guard is hit |
| Playback is slow or seeks stall | Compare releases, inspect stream diagnostics, provider failures, connection limits, and cache activity; performance varies by provider and RAR/NZB layout |
| Repair stops for limits or disk space | Open **Repairs**, check the failure disposition, free space, parity availability, and advanced repair limits |

For deeper configuration and repair-limit details, use the
[advanced setup reference](setup.md) and [Jellyfin compatibility guide](jellyfin-compatibility.md).
