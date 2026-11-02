# LOCAL-SERVER — "Server on this device" screens (Android TV app)

Status: in-progress

Branch `fb/client-local-server` (worktree `streamarr-wt/client-local-server`), based on `main` + the JS contract commit
(`client/modules/embedded-server/{types,index,mock}.ts`, owned by the `fb/embedded-server` branch — not modified here).

Intent: the box owner picks "use this TV as the server" in onboarding (or Settings, or the deep link
`streamarr://server/local`), starts the bundled Core Server, scans a QR code with the phone to configure it in the
web UI, then connects the app to `http://127.0.0.1:<port>` like any other server.

## Decisions

- **Route:** `client/src/app/(onboarding)/server/local.tsx` → `/server/local`, a sibling of the onboarding server
  step at the root stack, **outside the `(app)` gate**. The same route serves onboarding (no account yet), Settings
  (pushed over the tabs as a full-screen page, like "add another server") and the deep link. Back with nothing below
  it (cold deep link) replaces to `/` (the gate then picks onboarding or the app) instead of closing the app.
- **Deep link** `streamarr://server/local` (Streamybox OS Settings page, server notification; ACTION_VIEW, scheme
  `streamarr`, host `server`, path `/local`): no extra mapping needed — expo-router reads the host as the first path
  segment (same as `routeFromUrl`), and the generated manifest's intent filter accepts `streamarr` with any host. Cold
  start lands on the screen even with no account (the route is outside the gate); warm links go through
  `+native-intent` → `handleTitleLink`, which returns non-title links unchanged. Pinned by jest
  (`local-server-screen.test.tsx`, "deep link"). Dev builds show the Expo dev launcher on a cold-start link (dev-client
  behaviour), so cold start is proven in jest, the warm link on the emulator.
- **QR address:** native `addresses[].kind` is exactly `lan`, `tailscale`, `loopback` (+ `other`). The QR encodes
  `lan`, else `tailscale`, else `other`, **never `loopback`** (the phone is another device) — the same rule as the
  Streamybox Settings page. The list shows all, QR address first, loopback last (`local-server/model.ts`).
- **The app's own connection** uses the loopback entry of the running process (`localBaseUrl`), not `status.port`: a
  port change applies on the next start (shown as an info line) and must not break the readiness checks meanwhile.
- **Status as a TanStack query** (`['localServer','status']`) fed by `addStatusListener` and the mutations: Settings
  badge and screen share it, focus/app-resume refetch come for free. Readiness probes (`/api/v1/health` via the probe
  XHR, then `probeServer` = `/api/v1/viewer/auth/options`) poll every 3 s only while the screen is focused and the
  server runs; a stopped server drops their results. Failures in the first 30 s after `startedAt` still read as
  "checking" (startup grace). `module_disabled` → "turn on viewer accounts in the web UI".
- **Connect:** when ready — no profile on this server: "Connect to this server" → `/sign-in?server=http://127.0.0.1:<port>`
  (probe result seeded into `queryKeys.serverOptions`, exactly like the server step); a signed-in profile on it:
  "Switch to this server" (`activate` + `enterApp`); the active profile is on it: "Back to the app". Both offer
  "Sign in with another account". Server identity via `serverKey` (localhost / 127.0.0.1 / [::1] are one server).
- **Errors:** native rejections become `AppError('local_server_failed' | 'local_server_unavailable', { detail })`
  (new client codes, both locales, category T10/T11) and render through `FormError`/`describeError`; the native
  message is never shown as UI text except `status.lastError`, which the contract defines as an English detail.
- **Two-step reset** (no popups): first OK arms (destructive look, "Press again to reset", 6 s, disarms on blur),
  second OK resets; the fresh password is then shown in the credentials card. Credentials are fetched only while the
  screen is focused, masked by default, hidden again when the page is left, never logged.
- **Autostart** uses the app's radio-chip idiom (On / Off `GlassChip`s like Language/Performance) instead of a switch
  (the app has none). **Port** is an always-visible field + "Save port" (1024–65535, applies on next start).
- **Log:** inline panel (last 200 lines, monospace, refresh); on TV every 8 lines are one focus stop so the remote can
  scroll through it.
- **QR component** extracted from two-factor setup to `components/ui/qr-code.tsx` (same black-on-white quiet zone);
  TV size `px(208)` ≈ 416 px on a 1080p panel.
- **Device wording:** ICU `select` (`tv` → "this TV" / "diesem Fernseher", other → "this device" / "diesem Gerät").
- **Layout:** TV and tablets two columns (left: status, readiness + connect, settings; right: QR + addresses, web UI
  sign-in), phones one column; the log spans the width below.

## Evidence

## Follow-ups
