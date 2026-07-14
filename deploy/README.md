# Streamarr home bundle

This bundle contains the production Compose definition and the Jellyfin plugin that
match the release. The Streamarr Core image contains both the API server and the built
Management UI.

1. Copy `.env.example` to `.env` and fill both empty secrets with independent random
   values of at least 32 characters (`openssl rand -base64 32`).
2. Run `docker compose pull && docker compose up -d`.
3. Wait for `docker compose ps` to report Streamarr as healthy, then open the address
   configured by `STREAMARR_BIND_ADDRESS` and `STREAMARR_PORT`.

To start the included Jellyfin 10.11.11 container too, run
`docker compose --profile jellyfin up -d`. If Jellyfin already exists, the easiest way to
add the plugin is Jellyfin's plugin catalog: add
`https://raw.githubusercontent.com/TilDoesCode/streamarr/main/manifest.json` under
**Dashboard → Plugins → Repositories**, install **Streamarr** from **Catalog**, and
restart Jellyfin. Otherwise copy the contents of `plugin/` to
`<jellyfin-config>/plugins/Streamarr/`, ensure Jellyfin can write that directory, and
restart Jellyfin.

Already run **Komodo**? `compose.komodo.yml` is a minimal Core-only stack you can paste
straight into a Komodo UI stack — see `docs/install-komodo.md` in the repository.

Keep `.env` private. Persist and back up the `streamarr-data` and `streamarr-keys`
volumes together. The full installation, upgrade, reverse-proxy, backup, and first-run
instructions are at the top of the repository README.
