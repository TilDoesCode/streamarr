# Streamarr Management UI (`web/`)

React 19 + TypeScript SPA that configures, operates, tunes, and debugs the Core
Server. It talks **only** to the public `/api/v1` contract and must keep working with
Jellyfin absent (BRIEF §3.1 rule 4, §9).

> **Status: M4 complete.** Every §9.1 view is live — login + auth guard, dashboard,
> indexers, providers, quality profiles (with live preview), search/debug playground,
> playback preview, sessions, and settings. Vitest component tests cover the two
> logic-heavy views and a **Playwright smoke E2E** proves the interface-agnostic
> contract end-to-end with Jellyfin absent (see *Testing* below).

## Stack

- **Vite** + **React 19** + **TypeScript**, **Tailwind CSS** + shadcn/ui-style
  primitives (`src/components/ui`), **lucide-react** icons.
- **TanStack Router** (typed, code-based routes) for routing + the auth guard.
- **TanStack Query v5** for all server state (query keys + mutations with invalidation;
  `refetchInterval` for the dashboard). No Redux.
- **react-hook-form + zod** for forms, with validation mirroring the server.
- **openapi-typescript** generated types + a thin typed `fetch` wrapper (`src/api`).
- **sonner** toasts for the typed error envelope; **Vitest + Testing Library** for tests.

## Commands

```bash
npm ci
npm run generate:api   # ../server/openapi/v1.json → src/api/schema.d.ts (checked in)
npm run dev            # Vite dev server on :5173
npm test               # Vitest + Testing Library (component tests, src/**)
npm run typecheck      # tsc project build, no emit
npm run build          # type-check + production SPA build → dist/
npm run e2e            # Playwright smoke E2E (boots the real server, see Testing)
```

The checked-in `.npmrc` disables dependency lifecycle scripts during installation. The
current toolchain builds without them; `package.json` also records the reviewed, pinned
`esbuild` script approval for npm's future allow-list enforcement.

## Testing

- **Vitest + Testing Library** (`src/**/*.test.tsx`) — component tests focused on the two
  logic-heavy views: the **Quality Profiles editor** (built-in read-only guard, the live
  preview's ranked ordering, and edited draft weights flowing into the `POST /debug/search`
  re-rank) and the **Search/Debug table** (rejected-release listing + reasons, the *show
  rejected*/name filters, sort re-ordering, breakdown-row expansion, and resolve → health
  outcome + media info). Vitest is scoped to `src/` so it never collects the E2E specs.
- **Playwright smoke E2E** (`e2e/smoke.spec.ts`) — the acceptance test for BRIEF §3.1
  rule 4. `npm run e2e` builds the SPA, then boots the **real Core Server** via the
  `Streamarr.E2E.Harness` launcher (`server/tests/Streamarr.E2E.Harness`) against an
  **in-process mock NNTP server + canned indexer/TMDB fixtures + a seeded admin**, serving
  the built SPA at a single origin, and drives **login → add indexer → search → resolve →
  preview-play → logout**. It asserts HttpOnly cookie authentication, capability-only media
  URLs, single-session handoff, mobile controls, accessible drawer focus, cross-tab logout,
  and that the `<video>` reaches `readyState ≥ 2` and `currentTime` advances — real bytes,
  real decode — **with Jellyfin absent**. The fixture media is a
  real WebM (VP8 + Opus) generated with ffmpeg so the bundled Chromium can decode it, so
  `ffmpeg` must be on the PATH. The harness needs the .NET 8 SDK (`~/.dotnet/dotnet`).
  All three — `web`, `e2e`, and the spec/client drift check — run in
  `.github/workflows/ci.yml`.

## Dev vs. prod serving (both implemented — BRIEF §4)

- **Dev:** `npm run dev` runs Vite on `:5173` and proxies `/api` + `/openapi` to the
  Core Server (`http://localhost:5199` by default; override with the
  `STREAMARR_SERVER_ORIGIN` env var). See `vite.config.ts`.
- **Prod:** `npm run build` emits a static bundle to `dist/`. Copy it into the Core
  Server's `wwwroot/` and the server serves it as static files with an **SPA fallback**
  (`StreamarrServerBootstrap.UseStreamarrServer`): client-side routes like `/settings`
  resolve to `index.html`, static assets are served directly, and `/api` + `/openapi`
  keep their own behavior (an unknown `/api` route stays a non-HTML auth/404 error, never
  the shell). Single container, single origin. Covered by `SpaServingTests` on the server.

## Generated API client (no hand-written API types)

The API types are generated from the Core Server's frozen OpenAPI spec — never written
by hand (BRIEF §3.1 rule 5, §9.2; DECISIONS.md #7):

```bash
npm run generate:api   # ../server/openapi/v1.json → src/api/schema.d.ts
```

`src/api/schema.d.ts` is checked in. CI regenerates it and **fails on any git diff**
(`.github/workflows/ci.yml`), so the client can never drift from the spec. Everything in
`src/api/types.ts` re-exports `components["schemas"][...]`; the thin `apiFetch` wrapper
(`src/api/client.ts`) uses the server's same-origin HttpOnly admin cookie, normalizes the typed
error envelope into `ApiError`, and redirects to login on 401. JavaScript persists only
non-secret username/role/expiry metadata; it never stores or sends the admin JWT.

## Why TanStack Router + openapi-typescript (DECISIONS.md #7)

- **openapi-typescript** emits plain types with **zero runtime**, pairs cleanly with
  TanStack Query, and keeps the client a transparent `fetch` we fully control — chosen
  over heavier codegen (orval / openapi-generator) that ships an opinionated runtime.
  The same frozen spec drives a future RN/Expo or TV client.
- **TanStack Router** gives first-class **typed routes** and integrates naturally with
  TanStack Query; its `beforeLoad` guard implements the auth redirect in one place
  (`src/router.tsx`). Routes are defined **code-based** (not the file-based plugin) so the
  route tree is explicit and deterministic under test — no generated `routeTree.gen.ts`.

## Layout

```
src/
  api/        schema.d.ts (generated), client.ts (fetch wrapper), types.ts, queries.ts, token.ts
  components/ ui/ (shadcn-style primitives), app-shell.tsx, theme-toggle.tsx, nav.ts
  lib/        auth.tsx (session context), theme.tsx (dark mode), utils.ts (cn)
  pages/      login, dashboard, indexers, providers, profiles, search, playback, sessions, settings/*
  router.tsx  typed route tree + auth guard
  main.tsx    providers (Theme, Query, Auth) + RouterProvider
e2e/          smoke.spec.ts — Playwright smoke E2E (drives the real server harness)
playwright.config.ts   builds the SPA + boots Streamarr.E2E.Harness as the webServer
```
