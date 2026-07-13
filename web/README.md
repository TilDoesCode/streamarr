# Streamarr Management UI (`web/`)

React 19 + TypeScript SPA that configures, operates, tunes, and debugs the Core
Server. It talks **only** to the public `/api/v1` contract and must keep working with
Jellyfin absent (BRIEF §3.1 rule 4, §9).

> **Status: M3 scaffold.** This directory currently holds only the generated API
> client and its tooling. The real application (TanStack Router views, TanStack Query,
> forms, playback preview) lands in **M4**.

## Generated API client (no hand-written API types)

The API types are generated from the Core Server's frozen OpenAPI spec — never written
by hand (BRIEF §3.1 rule 5, §9.2; DECISIONS.md #7):

```bash
npm install
npm run generate:api   # ../server/openapi/v1.json → src/api/schema.d.ts
```

`src/api/schema.d.ts` is checked into the repo. CI regenerates it and **fails on any
git diff** (`.github/workflows/ci.yml`), so the client can never drift from the spec:
if the server API changes, the spec is re-frozen and this file is regenerated in the
same change.

## Tooling choices (DECISIONS.md #7)

- **openapi-typescript** for the generated types + a thin typed fetch wrapper (added in
  M4) — chosen over heavier codegen (e.g. orval/openapi-generator) because it emits
  plain types with zero runtime, pairs cleanly with TanStack Query, and keeps the
  client a transparent `fetch` we control.
- **TanStack Router** (typed routes) + **TanStack Query** v5 for all server state — no
  Redux. Justification: first-class typed-route + query integration, and the same
  generated spec drives a future RN/Expo or TV client.
- **Vite**, **Tailwind + shadcn/ui**, **react-hook-form + zod**, **Vitest + Testing
  Library**, **Playwright** — per BRIEF §4. These are introduced in M4.
