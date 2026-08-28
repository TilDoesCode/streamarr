# Streamarr documentation

Use this page as the map. Most home-server installations only need the first three
guides; the remaining documents explain internals, integrations, and development.

## Start here

| Guide | What you will accomplish |
|---|---|
| [Installation](installation.md) | Install the Core, connect Jellyfin, and prove the first stream |
| [Configuration](configuration.md) | Add providers, indexers, TMDB, and choose a quality profile |
| [Operations](operations.md) | Expose Streamarr safely, upgrade it, back it up, and troubleshoot it |

If you already manage containers with Komodo, use the dedicated
[Komodo installation guide](install-komodo.md).

## Understand and customize Streamarr

| Guide | Subject |
|---|---|
| [Architecture](architecture.md) | The Core, management UI, Jellyfin plugin, and playback lifecycle |
| [Ranker tuning](ranker-tuning.md) | Release scores, rejection reasons, and custom quality profiles |
| [Jellyfin compatibility](jellyfin-compatibility.md) | Supported Jellyfin version and upgrade checks |
| [API reference](api.md) | Authentication and the `/api/v1` contract for other clients |
| [Advanced setup reference](setup.md) | Full option reference, development stack, proxy details, and optional services |

The live OpenAPI document is also available at `/openapi/v1.json`; Swagger UI is
enabled at `/swagger` in Development.

## Contribute

- [Contributing guide](../CONTRIBUTING.md) — source layout, local setup, tests, and pull
  requests.
- [Security policy](../SECURITY.md) — supported versions and private vulnerability
  reporting.
- [Design decisions](DECISIONS.md) — settled project constraints.
- [Product brief](BRIEF.md) — the original detailed product and architecture brief.

## Measurements and acceptance records

These documents preserve implementation evidence rather than acting as setup guides:

- [Latency measurements](m1-latency.md)
- [Jellyfin acceptance checklist](m5-acceptance.md)
- [Cache and load-test report](m7-cache-loadtest.md)

Release changes are recorded on the
[GitHub Releases page](https://github.com/TilDoesCode/streamarr/releases).
