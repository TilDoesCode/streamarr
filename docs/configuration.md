# Configuration

Streamarr starts with only an administrator account and a machine key. Real search and
playback require a provider, an indexer, and usually TMDB. Almost everything can be
configured from the management UI without editing files.

## The shortest working setup

| Item | Why it is needed | Where to configure it |
|---|---|---|
| Usenet provider | Supplies the NNTP articles that become the media stream | **Providers** |
| Newznab indexer | Finds releases and supplies NZB links | **Indexers** |
| TMDB credential | Finds canonical movies/series and supplies metadata and artwork | **Settings → General** |
| Quality profile | Decides which releases to accept and prefer | **Profiles** |

The built-in **Standard** profile is ready to use, so the first three entries are the
only source configuration needed for an initial test.

Use the **Test** action after adding a provider or indexer. A green container healthcheck
only means the Streamarr process is alive; these connection tests prove the external
credentials and addresses.

## Administrator and machine credentials

The Docker deployment uses two unrelated credentials:

- `STREAMARR_ADMIN_PASSWORD` bootstraps the `admin` account on a brand-new database.
- `STREAMARR_API_KEY` authenticates Jellyfin and other machine clients.

Changing the bootstrap password in `.env` does not reset an administrator who already
exists. Change that password in the management UI instead. Additional scoped machine
keys can also be created in **Settings → API keys**.

Provider passwords and indexer/API keys are encrypted before they are stored in SQLite.
The encryption keys live in the separate `streamarr-keys` volume, which is why that
volume must be backed up together with `streamarr-data`.

## Usenet providers

For each provider, enter the hostname, NNTP port, TLS setting, username, password, and
maximum connection count supplied by the provider. Port `563` with TLS is common; use
your provider's actual values.

Streamarr shares a global connection budget across search checks, playback, optional
pre-downloads, and repairs. Do not set a provider's connection count above the account
limit. If you have a block account or secondary provider, add it with a lower priority
and mark it as backup-only where appropriate. Streamarr can retry missing articles
through another configured provider.

## Newznab indexers

Add the indexer's Newznab API base URL and API key. The **Test** action reads its
capabilities and reports latency. Multiple enabled indexers are searched together; one
slow or unavailable indexer does not have to stop the others from returning results.

Only use indexers you trust. Streamarr accepts NZB links from the configured indexer
origin and applies size and content limits before parsing them.

## TMDB

TMDB powers title discovery, canonical movie/series identity, metadata, and artwork.
Streamarr accepts either a short v3 API key or an API Read Access Token. Add it under
**Settings → General** after the first login.

Without TMDB, the low-level release diagnostics can still inspect raw indexer results,
but normal title discovery and Jellyfin injection are intentionally limited.

## Quality profiles and release selection

The Standard profile gives sensible defaults. A profile can prefer resolutions,
sources, codecs, languages, release groups, size ranges, and custom formats. It can
also reject releases before scoring them.

Use **Search → Release diagnostics** to understand a choice: it shows accepted and
rejected releases, parsed details, the score contribution of each rule, and the exact
rejection reason. The profile editor can preview unsaved changes against a sample
search.

Existing Sonarr or Radarr profiles and supported custom-format scores can be imported.
Review the preview before saving because Streamarr intentionally supports the portable
selection rules, not every file-management setting from an `*arr` application.

See [Ranker tuning](ranker-tuning.md) for worked examples.

## Cache, pre-downloads, and disk use

Streamarr streams on demand, but it is not a zero-disk application. The data volume can
contain:

- the SQLite database and encrypted configuration;
- cached NZB documents and media metadata;
- retained stream materializations;
- optional current-file and next-episode pre-downloads; and
- temporary or retained PAR2 repair artifacts.

The caches are bounded and configurable. The optional pre-download policy can finish
the current item after playback begins and prepare the next TV episode after a watch
threshold. It runs at lower priority than active playback and is disabled by default.

Configure it under **Settings → Pre-download**. Pay particular attention to the cache
path, minimum free-space reserve, concurrency, and next-episode threshold on a small
disk.

## Fallback and PAR2 repair

Before playback, Streamarr checks whether a release is still available and can try the
next suitable release automatically. During playback it can also fail over between
providers. When articles are missing and no healthy alternative is available, the
repair pipeline can reconstruct supported releases from their PAR2 data.

The default repair policy favors a healthy alternative before doing repair work. The
**Repairs** page shows active jobs, progress, limits, and retained artifacts. Repair can
consume significant temporary disk space and provider bandwidth; review the advanced
limits before changing its defaults.

## Jellyfin plugin settings

The plugin needs three values:

- **Core Server URL** — reachable by the Jellyfin server itself;
- **Public stream URL** — reachable by every playback device when the Core URL is an
  internal container hostname; and
- **API key** — the machine key, not the administrator password.

Search interception is opt-in. When enabled, failures and timeouts deliberately fall
back to Jellyfin's native results. Keep the plugin and Core versions matched and check
[Jellyfin compatibility](jellyfin-compatibility.md) before upgrading Jellyfin.

## Optional integrations

### Indexer-only HTTP proxy

Set `INDEXER_PROXY` to an `http://` proxy that the Core container can reach, for example
`http://gluetun:8888`. It routes Newznab capability checks, searches, and NZB retrieval
through that proxy. TMDB and NNTP traffic stay direct. If the configured proxy fails,
Streamarr does not silently retry those indexer requests outside it.

### Pushover notifications

Under **Settings → Notifications**, add a Pushover application token and user/group key,
then send a test. Notifications for playback, failures, outages, and recovery are
individually configurable and are delivered outside the playback request path.

### Jellyfin logs in Streamarr

The Logs view always includes a bounded, sanitized Core feed. It can optionally merge
relevant Jellyfin warnings and Streamarr-related entries when a Jellyfin administrator
API key and server URL are supplied. Treat that key as an administrator secret.

## Advanced reference

The exhaustive option table, environment-variable mapping, development settings, and
resource limits remain in the [advanced setup reference](setup.md#7-configuration-reference-streamarroptions).
For network and lifecycle settings, continue with [Operations](operations.md).
