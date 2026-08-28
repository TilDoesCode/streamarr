# Installation

This guide installs a release build of Streamarr on a home server, walks through the
first configuration, and optionally connects Jellyfin. For a five-minute Core-only
start, use the [minimal Compose example in the README](../README.md#quick-start).

## Before you begin

You need:

- a 64-bit Intel/AMD or ARM Linux host;
- Docker Engine with the Docker Compose plugin;
- `curl`, `tar`, `openssl`, and either `sha256sum` or `shasum`;
- a Usenet provider account;
- at least one Newznab-compatible indexer and API key; and
- a TMDB v3 API key or API Read Access Token for catalog search and artwork.

Jellyfin is optional. Streamarr's own management UI can search, resolve, and preview a
browser-compatible stream without it. The current plugin is tested against
**Jellyfin 10.11.11**.

## Choose an installation path

The release bundle is recommended for a home server. It keeps the Core image, Compose
file, environment template, and Jellyfin plugin on matching versions.

| Path | Best for |
|---|---|
| [Release bundle](#install-the-release-bundle) | A reproducible home-server installation |
| [Minimal Compose](../README.md#quick-start) | Trying the Core quickly with the `latest` image |
| [Komodo](install-komodo.md) | An existing Komodo-managed Docker host |
| [Build from source](setup.md#1-quick-start--the-dev-stack) | Development and contribution |

## Install the release bundle

Open the [latest GitHub release](https://github.com/TilDoesCode/streamarr/releases/latest)
and note its version. The example below uses `0.14.0`; replace it when a newer release
exists.

```bash
mkdir streamarr
cd streamarr
VERSION=0.14.0
curl -fLO "https://github.com/TilDoesCode/streamarr/releases/download/v${VERSION}/streamarr-home-${VERSION}.tar.gz"
curl -fLO "https://github.com/TilDoesCode/streamarr/releases/download/v${VERSION}/SHA256SUMS"
```

Verify the archive before extracting it:

```bash
# Linux
grep "streamarr-home-${VERSION}.tar.gz" SHA256SUMS | sha256sum --check -

# macOS
grep "streamarr-home-${VERSION}.tar.gz" SHA256SUMS | shasum -a 256 --check -
```

Then extract it:

```bash
tar -xzf "streamarr-home-${VERSION}.tar.gz"
```

The bundle contains:

- `compose.yml` — the hardened Core service and optional Jellyfin profile;
- `.env.example` — a version-pinned configuration template;
- `plugin/` — the matching Jellyfin plugin; and
- `compose.proxy.yml` and `compose.komodo.yml` — optional deployment variants.

## Create the private environment file

Copy the template and generate two different random values:

```bash
cp .env.example .env
openssl rand -hex 32
openssl rand -hex 32
```

Open `.env` and paste one value into `STREAMARR_ADMIN_PASSWORD` and the other into
`STREAMARR_API_KEY`. Keep them different:

- the admin password signs in to the management UI;
- the machine API key connects Jellyfin and other clients to the Core.

The official Compose file refuses to start while either value is empty. Protect the
file from other local users:

```bash
chmod 600 .env
```

The default bind is `127.0.0.1:8080`, which is safe for local access or a reverse proxy
on the same host. Do not publish port 8080 directly to the internet. See
[Network access](operations.md#network-access) before changing the bind address.

## Start the Core

```bash
docker compose pull
docker compose up -d
docker compose ps
```

Wait until the `streamarr` service reports `healthy`, then open
`http://127.0.0.1:8080` and sign in as `admin` with the configured admin password.

The shallow container healthcheck proves that the service and database started. It
does not prove that your provider and indexer credentials work; the next section does.

Database migrations run automatically. The image includes the API, management UI,
and `ffprobe`, so no extra application container or migration command is needed.

## Complete the first-run setup

Configure these in order:

1. Open **Providers**, add your Usenet server, and use **Test**.
2. Open **Indexers**, add a Newznab URL and API key, and use **Test**.
3. Open **Settings → General** and add the TMDB credential.
4. Start with the built-in **Standard** quality profile. You can tune or import a
   Sonarr/Radarr profile later.

Now open **Search**:

1. Find a movie or series.
2. Open **Release diagnostics** to see what Streamarr accepted or rejected.
3. Resolve a release.
4. Select a browser-compatible release, choose **Preview**, and confirm that playback
   starts and seeking works.

That browser preview tests the entire indexer → NZB → provider → media stream path
without Jellyfin. It does not transcode: an MKV or codec unsupported by the browser can
fail even when the source path is healthy and Jellyfin could play it by transcoding.
The [configuration guide](configuration.md) explains each source and optional setting.

## Connect Jellyfin

### Existing Jellyfin server

In Jellyfin:

1. Open **Dashboard → Plugins → Repositories**.
2. Add
   `https://raw.githubusercontent.com/TilDoesCode/streamarr/main/manifest.json`.
3. Install **Streamarr** from **Catalog** and restart Jellyfin.

Open **Dashboard → Plugins → Streamarr** and set:

- **Core Server URL** — the private address Jellyfin itself can reach. Use
  `http://streamarr:8080` when both containers share a Compose network,
  `http://127.0.0.1:8080` for a native Jellyfin process on the same host, or the
  server's private address for another host.
- **Public stream URL** — an HTTPS or private-LAN base URL reachable by phones, TVs,
  browsers, and every other playback device. This is required when the Core URL uses a
  container-only hostname such as `streamarr`.
- **API key** — the exact `STREAMARR_API_KEY` from `.env`.

Select **Test connection**, then enable search interception. The test verifies both
Core availability and the machine key.

### Bundled Jellyfin container

The home bundle can start its pinned Jellyfin container and mount the matching plugin:

```bash
# On Linux, set JELLYFIN_UID and JELLYFIN_GID in .env to `id -u` and `id -g` first.
docker compose --profile jellyfin up -d
```

Jellyfin listens on `127.0.0.1:8096` by default. Complete its setup wizard, then use
`http://streamarr:8080` as the Core Server URL in the plugin settings.

Keep Jellyfin on the version listed in the
[compatibility document](jellyfin-compatibility.md), and keep Streamarr Core and plugin
versions matched.

## Next steps

- Read [Configuration](configuration.md) for quality profiles, cache behavior,
  pre-downloads, repair, notifications, and indexer-only proxying.
- Read [Operations](operations.md) before exposing, upgrading, or backing up the service.
- Read [Ranker tuning](ranker-tuning.md) when you want to change how releases are chosen.
