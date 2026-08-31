<p align="center">
  <img src="docs/assets/streamarr-mark.svg" width="112" alt="Streamarr logo">
</p>

<h1 align="center">Streamarr</h1>

<h2 align="center">Usenet, ready when you press play.</h2>

<p align="center">
  Search, verify, and stream Usenet releases through Jellyfin or the built-in web
  preview—without a traditional download, import, and cleanup workflow.
</p>

<p align="center">
  <a href="https://github.com/TilDoesCode/streamarr/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/TilDoesCode/streamarr?display_name=tag&amp;sort=semver&amp;style=flat-square&amp;color=7c3aed"></a>
  <a href="https://github.com/TilDoesCode/streamarr/pkgs/container/streamarr"><img alt="Container platforms" src="https://img.shields.io/badge/GHCR-amd64%20%7C%20arm64-2496ED?style=flat-square&amp;logo=docker&amp;logoColor=white"></a>
  <a href="docs/jellyfin-compatibility.md"><img alt="Jellyfin 10.11.11" src="https://img.shields.io/badge/Jellyfin-10.11.11-00A4DC?style=flat-square&amp;logo=jellyfin&amp;logoColor=white"></a>
  <a href="LICENSE"><img alt="GPL-3.0 license" src="https://img.shields.io/github/license/TilDoesCode/streamarr?style=flat-square"></a>
  <img alt="Project status: active development" src="https://img.shields.io/badge/status-active%20development-f59e0b?style=flat-square">
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="docs/README.md">Documentation</a> ·
  <a href="https://github.com/TilDoesCode/streamarr/releases">Releases</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

---

> Streamarr is intended for legally obtained content. You are responsible for ensuring
> that your use complies with the laws and terms that apply to you.

Streamarr turns Newznab search results into seekable, on-demand streams from your
Usenet provider. It chooses a suitable release, checks that it is still available,
and can try an alternative before playback; provider failover and built-in repair cover
common interruptions. Jellyfin supplies the clients and transcoding; Streamarr also
works independently through its browser preview.

`Jellyfin or browser` → `Streamarr` → `Newznab indexers + Usenet providers`

## Why Streamarr?

- **Start sooner** — playback can begin without waiting for a complete download.
- **Feels native in Jellyfin** — movies, series, seasons, and episodes appear beside
  local media and use Jellyfin's normal clients and transcoding.
- **Chooses intelligently** — quality profiles, transparent scoring, availability
  checks, and quality-profile imports from Sonarr or Radarr help select the right release.
- **Recovers gracefully** — provider failover, automatic release fallback, and
  built-in repair cover common Usenet failure modes.
- **Understands TV** — season packs, exact episode selection, and optional preparation
  of the next episode are built in.
- **Explains itself** — the management UI shows searches, rejections, active streams,
  cache use, repairs, history, logs, and per-stream diagnostics.

No Sonarr, Radarr, or Prowlarr is required. Streamarr replaces the parts needed for
on-demand playback; it is not a general download manager or media-file organizer.

## What you need

- A 64-bit Intel/AMD or ARM Linux host with Docker Engine and Docker Compose.
- A Usenet provider and at least one Newznab-compatible indexer.
- A TMDB API credential for catalog search, metadata, artwork, and Jellyfin results.
- Jellyfin only if you want its apps and transcoding—Streamarr can preview
  browser-compatible releases by itself.

Streamarr supports Usenet/NZB only. It does not support torrents.

## Quick start

Save this as `compose.yml` in a new directory:

```yaml
services:
  streamarr:
    image: ghcr.io/tildoescode/streamarr:latest
    init: true
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    ports:
      - "127.0.0.1:8080:8080"
    environment:
      Streamarr__Admin__Password: "${STREAMARR_ADMIN_PASSWORD:?Set in .env}"
      Streamarr__ApiKey: "${STREAMARR_API_KEY:?Set in .env}"
    volumes:
      - streamarr-data:/app/data
      - streamarr-keys:/app/keys
    tmpfs:
      - /tmp:rw,noexec,nosuid,nodev,size=64m
    restart: unless-stopped

volumes:
  streamarr-data:
  streamarr-keys:
```

Generate two different secrets:

```bash
openssl rand -hex 32
openssl rand -hex 32
```

Save them as `.env` beside `compose.yml`:

```dotenv
STREAMARR_ADMIN_PASSWORD=paste-the-first-value-here
STREAMARR_API_KEY=paste-the-second-value-here
```

Protect the file, then start Streamarr:

```bash
chmod 600 .env
docker compose pull
docker compose up -d
```

Run `docker compose ps` again until the service reports `healthy`:

```bash
docker compose ps
```

Open [http://127.0.0.1:8080](http://127.0.0.1:8080) and sign in as `admin` with
`STREAMARR_ADMIN_PASSWORD`. The loopback bind is deliberate; for access from another
device, see [network access and reverse proxies](docs/operations.md#network-access).

In the management UI:

1. Add and test a **Usenet provider**.
2. Add and test a **Newznab indexer**.
3. Add a **TMDB credential** under Settings → General.
4. Keep the built-in **Standard** quality profile or customize one later.
5. Search for a title, resolve a browser-compatible release, and use **Preview** to
   validate the complete source path before connecting Jellyfin.

Database migrations happen automatically. The two named volumes preserve the database,
caches, encrypted secrets, and their encryption keys; back up `streamarr-data` and
`streamarr-keys` together.

For a version-pinned home bundle, a hardened full Compose file, checksum verification,
or a bundled Jellyfin container, follow the [installation guide](docs/installation.md).

## Connect Jellyfin

Streamarr is currently tested against **Jellyfin 10.11.11**.

1. In Jellyfin, open **Dashboard → Plugins → Repositories** and add:
   `https://raw.githubusercontent.com/TilDoesCode/streamarr/main/manifest.json`
2. Install **Streamarr** from the catalog and restart Jellyfin.
3. In the plugin settings, enter the Core URL and the exact `STREAMARR_API_KEY`. Test
   the connection, then enable search interception. Playback devices always stream
   from Jellyfin itself, so the Core URL only needs to be reachable by Jellyfin.

Keep the plugin and Core on matching Streamarr versions. Read the
[Jellyfin setup](docs/installation.md#connect-jellyfin) and
[compatibility notes](docs/jellyfin-compatibility.md) before upgrading Jellyfin.

## Documentation

| Guide | Use it for |
|---|---|
| [Installation](docs/installation.md) | Release bundles, Docker, Jellyfin, Komodo, and first playback |
| [Configuration](docs/configuration.md) | Providers, indexers, TMDB, profiles, and optional features |
| [Operations](docs/operations.md) | Networking, upgrades, backups, logs, and troubleshooting |
| [All documentation](docs/README.md) | Architecture, API, ranker tuning, compatibility, and development |

Komodo users can go directly to the [copy-paste Komodo guide](docs/install-komodo.md).

## Project status

Streamarr is under active `0.x` development. Releases are usable, packaged for
`linux/amd64` and `linux/arm64`, and covered by automated server, web, plugin,
container, and browser-to-stream tests—but configuration and behavior can still change
between minor versions. Read the [release notes](https://github.com/TilDoesCode/streamarr/releases)
before upgrading.

Performance depends on the provider, indexer, release layout, and network. Search
interception is tied to a tested Jellyfin version and deliberately falls back to native
Jellyfin search if Streamarr is unavailable.

## Community, security, and license

Contributions are welcome; start with [CONTRIBUTING.md](CONTRIBUTING.md). Please report
vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in a public
issue.

Streamarr is licensed under [GPL-3.0](LICENSE). Third-party notices and attribution are
listed in [NOTICE](NOTICE).
