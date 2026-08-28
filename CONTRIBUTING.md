# Contributing to Streamarr

Thanks for helping improve Streamarr. Bug reports, compatibility findings,
documentation fixes, tests, and focused pull requests are welcome.

For a vulnerability, stop here and use the private process in
[SECURITY.md](SECURITY.md).

## Before opening a change

- Search existing issues and pull requests to avoid duplicate work.
- For a large feature or architecture change, open an issue first so the intended user
  experience and boundaries can be agreed before implementation.
- Keep real provider, indexer, TMDB, Jellyfin, NZB, and Streamarr credentials out of
  issues, fixtures, logs, screenshots, commits, and pull requests.
- Read [docs/architecture.md](docs/architecture.md) for the component boundaries.

Two rules are fundamental:

1. Domain logic belongs in Streamarr Core; the Jellyfin plugin remains a thin adapter.
2. The management UI must still be able to search, resolve, and preview a stream with
   Jellyfin absent.

## Development prerequisites

- .NET SDK 8 for the Core and .NET SDK 9 for the Jellyfin plugin;
- Node.js 24 and npm;
- Docker Engine with Docker Compose;
- ffmpeg/ffprobe for media integration tests; and
- a 64-bit Intel/AMD or ARM development host.

The automated suites use mock NNTP, Newznab, and TMDB fixtures. Real service
credentials are not required to run the normal tests.

## Repository layout

| Directory | Purpose |
|---|---|
| `server/` | ASP.NET Core API, search/ranking, Usenet streaming, persistence, and tests |
| `web/` | React management UI and browser end-to-end tests |
| `plugin/` | Jellyfin adapter and host-compatibility tests |
| `deploy/` | Release Compose definitions and environment templates |
| `docs/` | User, operator, architecture, API, and acceptance documentation |

## Run the development stack

```bash
cp .env.example .env
openssl rand -hex 32
openssl rand -hex 32
```

Put the two different values into `STREAMARR_ADMIN_PASSWORD` and
`STREAMARR_API_KEY`, then build the plugin and start Core plus Jellyfin:

```bash
dotnet build plugin/Streamarr.Plugin/Streamarr.Plugin.csproj -c Release
docker compose -f docker-compose.dev.yml up --build
```

The Core and built management UI are available at `http://127.0.0.1:8080`; Jellyfin is
at `http://127.0.0.1:8096`. To run the Vite development server too:

```bash
docker compose -f docker-compose.dev.yml --profile web up --build
```

See [docs/setup.md](docs/setup.md) for native commands, proxy details, and the complete
option reference.

## Run the checks

### Core

```bash
dotnet restore server/Streamarr.sln
dotnet build server/Streamarr.sln -c Release --no-restore
dotnet test server/Streamarr.sln -c Release --no-build
```

### Jellyfin plugin

```bash
dotnet restore plugin/Streamarr.Plugin.sln
dotnet build plugin/Streamarr.Plugin.sln -c Release --no-restore
dotnet test plugin/Streamarr.Plugin.sln -c Release --no-build
```

Changes near Jellyfin integration should also run the isolated host-load smoke test:

```bash
bash plugin/scripts/smoke-jellyfin.sh
```

### Management UI

```bash
cd web
npm ci
npm run typecheck
npm test
npm run build
```

Browser-facing workflow changes should run the relevant Playwright tests. The full
suite is:

```bash
cd web
npx playwright install chromium
npm run e2e
```

### API contract changes

The OpenAPI document and generated TypeScript types are checked in. After changing an
endpoint or contract:

```bash
server/scripts/freeze-openapi.sh
cd web
npm run generate:api
```

Commit both `server/openapi/v1.json` and `web/src/api/schema.d.ts` with the code change.
Do not hand-edit the generated TypeScript schema.

## Pull-request checklist

- Keep the change focused and explain the user-visible outcome.
- Add or update tests for behavior changes and failure paths.
- Update the README or a dedicated document when setup, compatibility, configuration,
  or operations change.
- Preserve native Jellyfin search when the Core is unavailable.
- Confirm no secret, private URL, release name, message ID, or real NZB data entered the
  diff.
- Run the relevant checks above and report anything you could not run.

UI changes should include current screenshots for the affected desktop/mobile and
light/dark states where those states matter.

## Licensing and attribution

By contributing, you agree that your contribution is provided under the repository's
[GPL-3.0 license](LICENSE). Preserve existing attribution headers and add source
attribution when porting compatible third-party code. See [NOTICE](NOTICE) and
[docs/DECISIONS.md](docs/DECISIONS.md) for the project's licensing boundaries.
