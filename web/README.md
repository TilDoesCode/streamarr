# Streamarr Management UI (`web/`)

React 19 + TypeScript SPA that configures, operates, tunes, and debugs the Core
Server. It talks **only** to the public `/api/v1` contract and must keep working with
Jellyfin absent (BRIEF §3.1 rule 4, §9).

> **Status: M4a.** Login, admin-JWT auth guard, the app shell (sidebar for every §9.1
> view, dark-mode toggle, tablet-responsive), and the **Settings** view (general
> config, machine API keys, admin password) ship here. The other §9.1 views (indexers,
> providers, quality profiles, search/debug, playback preview, sessions) are routed
> **placeholders** — present so the shell nav is complete — and land in later M4 tasks.

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
npm install
npm run generate:api   # ../server/openapi/v1.json → src/api/schema.d.ts (checked in)
npm run dev            # Vite dev server on :5173
npm test               # Vitest + Testing Library
npm run typecheck      # tsc project build, no emit
npm run build          # type-check + production SPA build → dist/
```

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
(`src/api/client.ts`) injects the bearer token, normalizes the typed error envelope into
`ApiError`, and redirects to login on 401.

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
  pages/      login.tsx, dashboard.tsx, settings/*, placeholder.tsx
  router.tsx  typed route tree + auth guard
  main.tsx    providers (Theme, Query, Auth) + RouterProvider
```
