# Security policy

Streamarr handles administrator credentials, Usenet and indexer secrets, and
short-lived playback capabilities. Please report vulnerabilities privately so a fix can
be prepared before details are public.

## Supported versions

Security fixes target the latest released version and the current `main` branch. If you
report an issue against an older release, you may be asked to reproduce it after
upgrading.

The Jellyfin plugin is supported only with the version listed in
[docs/jellyfin-compatibility.md](docs/jellyfin-compatibility.md).

## Report a vulnerability

Private vulnerability reporting is not currently enabled for this repository. Open a
detail-free GitHub issue titled **Security contact request** and ask the maintainer to
establish a private reporting channel. Do not include the finding itself.

Do not put exploit details, credentials, capability URLs, NZB contents, or provider
information in a public issue, discussion, pull request, or commit.

Please include, when available:

- the affected Streamarr and Jellyfin versions;
- the deployment shape and relevant security settings;
- a clear description of the impact and required attacker access;
- minimal reproduction steps or a proof of concept;
- sanitized logs or requests; and
- any suggested mitigation.

Never send real provider, indexer, TMDB, Jellyfin, or Streamarr credentials. Replace
tokens, message IDs, release names, hostnames, and public stream URLs with obvious
placeholders.

You can expect the report to be acknowledged and triaged privately. Disclosure timing
will be coordinated after impact and a remediation path are understood.

## Deployment expectations

Streamarr's container serves plain HTTP because TLS normally terminates at a trusted
reverse proxy or VPN ingress. A secure installation should:

- keep port 8080 on loopback or a trusted private network;
- use HTTPS for access outside the Docker host;
- trust only exact reverse-proxy source addresses;
- keep `.env`, backups, provider credentials, and the data/key volumes private;
- exclude stream/session capability paths and query strings from access logs;
- use different values for the administrator password and machine API key; and
- keep the Core, Jellyfin plugin, Jellyfin host, and container base images current.

The [operations guide](docs/operations.md#network-access) has the supported networking
patterns. Security problems caused by intentionally publishing the plain Core port to
an untrusted network may still be useful reports, but that deployment is outside the
documented boundary.

## Scope notes

Good-faith reports about authentication, authorization, secret handling, capability
leakage, request forgery, unsafe archive/NZB parsing, path traversal, provider or
indexer origin validation, and container escape boundaries are especially valuable.

Reports that require unlawful access to third-party systems, denial of service against
public infrastructure, social engineering, or disclosure of other people's content or
credentials are not acceptable testing methods.
