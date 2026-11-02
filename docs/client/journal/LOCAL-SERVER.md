# LOCAL-SERVER — "Server on this device" screens (Android TV app)

Status: done

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
- **TV focus on this page** (found by driving it with the D-pad): button rows use an untrapped `ActionRow` (the
  Settings idiom `SettingsButtonRow` traps Right, which blocked the second column); cards are `FocusSection`s in an
  item-snap ScrollView (the focused card shows completely, incl. the port error under the field); the ScrollView is
  `focusable={false}` (Down with nothing focusable below parked focus on it); the readiness checklist is one
  non-interactive focus stop on TV so a failing check can be scrolled to. "Connect" takes preferred focus when it
  appears.
- **Reset button keeps one variant** (`secondary`): switching `Button`'s variant while it is focused left it red after
  the reset (its colours are UI-thread animated styles); the armed state shows in the label + a warning message.
- **Error codes** `local_server_unavailable` / `local_server_failed` are appended at the end of `CLIENT_ERROR_CODES`;
  the generated `docs/client/player/hint-catalogue.md` was regenerated (`UPDATE_CATALOGUE=1`), which renumbers the
  viewer-code rows F43+ (no references to those numbers outside the file).

## Files

- Routes: `client/src/app/(onboarding)/server/local.tsx` (+ `jest/app-routes.tsx`).
- State: `client/src/local-server/{model.ts,use-embedded-server.ts,state-badge.tsx,settings-entry.tsx}`.
- Screen: `client/src/screens/local-server/{local-server-screen,status-card,readiness-list,address-panel,server-settings,card}.tsx`.
- Entry points: `screens/onboarding/server-screen.tsx` (secondary choice under Connect), `screens/settings/settings-screen.tsx`
  (`LocalServerSection` after App).
- Shared: `components/ui/qr-code.tsx` (moved out of `account-security.tsx`), `components/icons.ts` (ScrollText,
  UserPlus), `api/error-codes.ts` + `error-categories.ts`, locales de/en (`localServer.*`, `onboarding.server.local*`,
  `errors.codes.local_server_*`).
- Tests: `local-server/__tests__/{model,use-embedded-server,settings-entry}.test.ts(x)`,
  `screens/local-server/__tests__/local-server-screen.test.tsx`, `jest/embedded-server-fake.ts`.

## Evidence

- `npm run typecheck` 0 errors, `npm run lint` clean, jest: see the last line of this section.
- Baseline before the work: jest 2371/2371 green (the 2 known-red tests on `main` did not fail in this worktree).
- New tests: 44 (model 19, hook 8 against the real dev mock incl. port-1 failure, screen 15 incl. 2 deep-link tests,
  Settings entry 2).
- Final run: typecheck exit 0, lint exit 0, **jest 2415/2415, 232 suites** (one earlier full run had `screens.test`
  time out at 5 s under emulator load; it passed alone, 103/103, and in the final run).
- Emulator `streamarr_dv_tv` (Android TV 14, port 5592), dev APK built from this tree, Metro with
  `EXPO_PUBLIC_EMBEDDED_SERVER_MOCK=1`, driven with the D-pad only (`adb input keyevent`; focus checked with
  `uiautomator dump`). The emulator's loopback 8080 was reversed to a **readiness stub** on the host (`/api/v1/health`,
  `/api/v1/viewer/auth/options`, switchable to `module_disabled`) because the published Dev World snapshot first has to
  generate ~70 media files (shared cache empty). Port 1 for the failed state was set in the mock via
  `debugger-evaluate` (the UI rightly refuses it). The QR in `androidtv-local-running.png` decodes (OpenCV) to
  `http://192.168.1.20:8080` (LAN, not loopback).
- Screenshots `docs/client/screenshots/LOCAL-SERVER/`: `androidtv-onboarding-entry`, `-local-stopped`,
  `-local-starting`, `-local-running-checking` (API check spinning), `-local-running`, `-readiness-ready`,
  `-readiness-viewer-off`, `-local-failed`, `-credentials-revealed`, `-settings-card`, `-port-invalid`, `-reset-armed`,
  `-de-reset-armed`, `-de-reset-done`, `-logs`, `-connect-sign-in` (Connect → sign-in at `http://127.0.0.1:8080`),
  `-deeplink-warm` (`streamarr://server/local` fired while the app ran), `-streamybox-onboarding`,
  `-streamybox-running`, `-streamybox-ready`, `-de-running` (German).

## Follow-ups

- **Contract** (`fb/embedded-server`, not changed here): (1) rejections are plain `Error`s — stable codes (`port_in_use`,
  `bundle_missing`, `service_unavailable`) would allow localized texts; (2) a `restart()` would let a port change apply
  without Stop + Start; (3) a `runningPort` (or the port the process bound) instead of deriving it from `addresses`;
  (4) a credentials-changed event (today the screen re-reads on focus).
- Not shown on a device: the Settings row (needs a signed-in account on a full server; covered by jest), phone/tablet
  layouts (only the TV AVD was allowed; the two-column/one-column switch is `formFactor`-based), the cold-start deep
  link (dev builds open the Expo dev launcher instead; verify on the box with a release build).
- Shared `Button`: changing `variant` while focused keeps the old colours (Reanimated UI-props sync) — fix in the
  component if another screen needs it.
- Toolchain: the shared `~/.gradle` Kotlin-DSL cache currently fails `@react-native/gradle-plugin` (`Unresolved reference
  'libs'`); built with `GRADLE_USER_HOME=~/.gradle-lsrv` seeded by APFS clones of `modules-2` + wrapper dists. adb reverse on
  the emulator stopped delivering after ~1 h (reboot fixed it). Another agent's iPhone simulator connected to Metro 8081.
- Argent 0.31.1 is available (installed 0.23.0); updating is the user's call.
