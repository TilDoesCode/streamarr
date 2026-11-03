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

## Integration on `fb/local-server` (merge with `fb/embedded-server`, real bundle)

Status: done. Worktree `streamarr-wt/local-server-integration`, branch `fb/local-server` = `fb/embedded-server`
(a9a8f0de) + `fb/client-local-server` (696c78a3), merged with `--no-ff` (da92c59b).

### Merge

- Conflicts only in `client/modules/embedded-server/{types,index,mock}.ts` (add/add): the foundation branch's final
  contract wins (error codes, `restart()`, `runningPort`, `onCredentialsChange`). The placeholder route
  `client/src/app/server/local.tsx` is deleted (the real screen at `(onboarding)/server/local.tsx` serves `/server/local`);
  `devServer.placeholder` removed, `devServer.title` stays for `/dev/server`. Locales: both key sets; Settings: the
  "Server on this device" section and the developer "Server lab" row. `jest/embedded-server-fake.ts` gained `restart()`
  and the credentials listener so the merge compiles. Every other file equals its branch of origin (checked with the
  merge-base diff).

### Wiring the final contract (small commits)

- `7fb60869` native error codes → client codes `local_server_{port_in_use,bundle_missing,service_unavailable,start_failed,
  stop_failed}` (+ the existing `_unavailable`, `_failed`), de/en, categories T10/T11, hint catalogue regenerated. The
  code comes from `error.code` or the `code: detail` prefix of the message (`lastError` too); the status card's failed
  message shows the localized title/message plus the English detail.
- `88e2a00b` `restart()` mutation; the port field's pending message offers **Restart now**; the status card shows the
  bound port (`runningPort`) and "8080 (9000 after a restart)" while a change waits; loopback URL and readiness probes
  follow the bound port instead of parsing the address list.
- `92d43278` the credentials card subscribes to `addCredentialsListener` and re-reads every 30 s while shown (that
  read runs the native login probe).
- Tests: model 23, hook 10 (against the real `mock.ts`, incl. restart to a new port and the credentials event), screen 19,
  Settings entry 2. Full jest **233 suites, 2430 tests** (was 2415), typecheck 0, lint clean. Config-plugin tests run
  inside jest (`plugins/__tests__`, with-embedded-server included).
- `dotnet test server/Streamarr.sln -c Release`: Usenet 247/247, Core 535/535, DevWorld 92/92, Server **1728 of 1741**
  — the 13 failures are the ffmpeg-9 "Invalid time base" cases in `RemuxIntegrationTests` (7) and
  `TranscodingIntegrationTests` (6); the same 13 names fail on an export of `main`'s `server/` sources (not touched here).

### Bugs found with the real server (fixed here)

- `9d3dab2d` **autostart status**: the first start flips the default to on (`started_once`) and the boot receiver
  honours it, but the status snapshot kept `autostart=false` until the next process start — the chips showed *Off*
  while a reboot would start the server. `waitForHealth` now syncs the status with the setting.
- `4f1f8164` **TV focus loss**: when the credentials card flips to *Changed in the web UI* its only focusable (Show)
  unmounts; with nothing focused no D-pad key did anything (only Back left the page). The hint line is now a focus
  stop on TV and takes the focus when the toggle it replaces was focused.

### End to end on the emulator (`sbx_streamarr_engine`, Android TV 14, port 5590, real bundle `0.20.1+b923880a`)

Debug APK `STREAMARR_EMBEDDED_SERVER=1`, no mock, Metro on 39781 for the dev client; D-pad only (`adb input keyevent`,
focus read with `uiautomator dump`; argent's screenshot server failed for this emulator, `describe` cannot see RN focus,
so `adb screencap` was used). Host "phone" = Playwright (web/node_modules) against `adb forward tcp:39780 tcp:8080`.

| Step | Result |
|---|---|
| Fresh data (`pm clear`), onboarding → *Use this TV as the server* | `02-local-stopped`: Stopped, port 8080, bundle 0.20.1+b923880a |
| Start | `03-starting` (Starting…), health answers **3 s** after the press, `04-running-viewer-off`: Running, 0.20.1, QR `http://10.0.2.15:8080`, LAN + loopback listed; `05-readiness-viewer-off`: "Turn on viewer accounts in the web UI" |
| Phone: web UI | `host-web-dashboard` (Service Ok v0.20.1), Viewers → Settings switch on, Viewers → Accounts → New viewer (`host-web-viewers-accounts`: module Enabled, 1 viewer). The dialog generated a password and kept "must change password", both fixed through the admin API (`POST …/password`, `PATCH …/{id}`) |
| Readiness flips | all four checks done within the 3 s poll, no restart; `07-readiness-ready` with *Connect to this server* focused |
| Connect | `08-connect-sign-in` (`Streamarr · http://127.0.0.1:8080`), `08b` wrong password → "Wrong username or password", `09-home-connected`: Home, profile "Living room", empty library, provider-outage banner (no providers yet) |
| Settings row | `10-settings-row-live`: "Server on this TV · Reachable at http://10.0.2.15:8080 · Running"; `11-from-settings-back-to-app` |
| App update | `adb install -r` of the fixed build: health back **4 s** after the command (`MY_PACKAGE_REPLACED`), no user action |
| `am kill` | both processes stay, health 200; reopened app shows Running (`12-after-kill-deeplink-warm`, chips On `13`) |
| `am force-stop` | server **down and not restarted** (Android keeps force-stopped packages stopped); reopened app shows Stopped (`14-after-force-stop`), Start again → `15` |
| Reboot (autostart on) | `boot_completed` after ~10 s, **health 3 s later** (device uptime 12 s) with the TV launcher in front; app then shows Running (`16-after-reboot-autostart`) |
| Port change | 8090 saved → `17-port-pending-restart-now` → Restart now → health on 8090 after **1 s**, 8080 closed, `19-port-8090-running` (Port 8090, QR `…:8090`); back to 8080 the same way |
| Stop, autostart off | `20-stopped-autostart-off` (pref `autostart=false`) |
| `port_in_use` for real | 8080–8099 held with `nc -l` on the device → Start → `21-start-port-in-use`: "No free port — Every port from the configured one upwards is taken…" |
| Start again, autostart on | `22-running-again` |
| Credentials flip | admin password rotated through `POST /api/v1/auth/password` while the card was on screen: *Changed in the web UI* after **5 s** (second run 24 s), `23`; focus stop `26`; Reset admin password two presses `24` → `25-reset-done-new-password`, the fresh password signs in (200), the rotated one no longer (401) |
| German | `de-settings-row` (Server auf diesem Fernseher · Erreichbar unter … · Läuft), `de-local-running`, `de-local-settings-card` |
| Streamybox theme | `debug.streamarr.theme=streamybox`: `streamybox-settings-row`, `-local-stopped`, `-local-running`, `-local-settings-card` |

Observed, not changed: expo-router logs "Can't perform a React state update on a component that hasn't mounted yet"
once (its `useLinking` promise) when a warm `streamarr://server/local` arrives right after the dev-client launch;
dev-only console error from `ContextNavigator`, not app code.

### Release build

`assembleRelease` signed with the Streamarr release key (`STREAMARR_ANDROID_*` from
`streamybox-work/keys/streamarr-release.properties`, signer `CN=Streamarr Android Release, O=Streamarr`), versionName
0.1.0 / versionCode 1000, 134 MB, bundle 0.20.1+b923880a and `index.android.bundle` inside. Installed after an uninstall
(different signer than the debug build, so the server data of the debug run is gone):

- cold start lands on onboarding, no dev launcher (`rel-01-onboarding`); *Use this TV as the server* → `rel-02-local-stopped`;
  first start healthy after 3 s; the autostart chips read **On** right after the first start (`rel-03`, the status fix on a
  fresh install);
- **cold deep link**: `am force-stop`, then `am start -a VIEW -d streamarr://server/local` opens the app directly on the
  local-server screen (`rel-04-deeplink-cold`; Stopped, because a force stop also ends the server — Start again took 2 s);
- **warm deep link** from onboarding lands on the screen with the running server (`rel-05-deeplink-warm`).

APKs (also for the Streamybox team's OS emulator): `/Volumes/DevSSD/Development/streamarr-work/local-server-integration/apk/`
`streamarr-tv-release-fb-local-server.apk` (signed release) and `streamarr-tv-debug-fb-local-server.apk` (debug, needs Metro).
The emulator `emulator-5590` stays up with the release build installed, the server running on 8080 and autostart on.

### Decisions

- The viewer account's "must change password" and its password were set through the admin API after the UI dialog
  (the Playwright script did not find the dialog's switch; the dialog generated a password); module switch, account creation
  and the screenshots went through the web UI as a user would.
- Readiness/credential polling stays in the hook (30 s for credentials): the native login probe only runs when
  `getCredentials()` is called, so the flip without refocus needs that poll; the event covers resets and the OS Settings page.
- `am force-stop` is documented as the one thing the server does not survive (Android semantics); no auto-start on app
  launch was added — it would start the server behind the user's back after an explicit force stop.
- Screenshots: full-size `adb screencap` PNGs (argent's screenshot tool could not attach its simulator-server to this
  emulator; `describe` sees no RN focus, so `uiautomator dump` served as the focus check).

### Limitations and follow-ups

- Metro on this worktree (external volume, no Watchman) missed file changes after a while: Fast Refresh silently served
  the old `address-panel.tsx` until Metro was restarted with `--clear`. Verify on-device claims against a fresh bundle.
- The debug build shows the Expo dev-menu onboarding and LogBox over the app; both block `uiautomator` (own windows) and
  the dev menu swallows D-pad input — launch the dev client with `disableOnboarding=1` and dismiss LogBox by a tap.
- `uiautomator dump` lists visible nodes only; a card below the fold is simply absent, not broken.
- The web UI's "New viewer" dialog: the password field and the must-change switch deserve stable ids for automation.
- Follow-up from the TV focus bug: other screens that unmount their only focusable on a data change may strand the
  remote the same way; a shared "focus fallback" in `Card`/`FocusSection` would cover them all.
- Argent 0.31.1 is available (installed 0.23.0); updating is the user's call.

### Screenshots (`docs/client/screenshots/LOCAL-SERVER-E2E/`)

`androidtv-01-onboarding-entry`, `02-local-stopped`, `03-starting`, `04-running-viewer-off`, `05-readiness-viewer-off`,
`06-credentials-revealed`, `07-readiness-ready`, `08-connect-sign-in`, `08b-sign-in-wrong-password`, `09-home-connected`,
`10-settings-row-live`, `11-from-settings-back-to-app`, `12-after-kill-deeplink-warm`, `13-autostart-on-after-update`,
`14-after-force-stop`, `15-restarted-after-force-stop`, `16-after-reboot-autostart`, `17-port-pending-restart-now`,
`18-restarting`, `19-port-8090-running`, `20-stopped-autostart-off`, `21-start-port-in-use`, `22-running-again`,
`23-credentials-changed-in-web-ui`, `24-reset-armed`, `25-reset-done-new-password`, `26-credentials-changed-focus-stop`,
`de-settings-row`, `de-local-running`, `de-local-settings-card`, `streamybox-settings-row`, `streamybox-local-stopped`,
`streamybox-local-running`, `streamybox-local-settings-card`, `rel-01-onboarding` … `rel-05-deeplink-warm`;
host (phone): `host-web-dashboard`, `host-web-viewers-settings-before/after`, `host-web-viewer-created`,
`host-web-viewers-accounts`. Passwords visible in `06`/`25` belong to the uninstalled debug install and are dead.

## Follow-up: Streamybox validation of the release APK

Streamybox validated the release APK against the OS contract (12/12 Settings tests, 24/24 lifecycle checks) and
found one discrepancy: during the restart behind `resetAdminPassword` (and `restart()`) the provider reported
`{"state":"starting","urls":[],"startedAt":<previous run>}`. Fixed in `ServerController`: every transition out of
`running` (stopping, stopped, starting, failed) goes through `ServerStatus.notRunning(state)`, which clears
`startedAt`, `runningPort` and `addresses`; the health check sets them afresh. The JS status therefore has
`startedAt`/`runningPort` undefined and `addresses` empty in every state but running (dev mock and jest fake follow).

Verified on emulator-5590 with the module's instrumented contract test — `adb shell content query` is denied to the
shell user, the permission is `signature|privileged` — new test `startedAtAndUrlsBelongToTheRunningProcessOnly`
samples the provider every 50 ms through a reset: `{"state":"starting",…,"startedAt":0,…,"urls":[]}`, then a fresh
`startedAt` greater than the previous one, and `startedAt` 0 / `urls` empty after `stop`. `OK (3 tests)`.

Two `lan` entries (eth0 + wlan0 on an emulator with both interfaces) stay. Every address carries `interfaceName`
(loopback now `lo`); the TV address list labels repeated kinds "LAN (eth0)" / "LAN (wlan0)" (de/en), unique kinds
look as before. Decision: the OS contract JSON keeps `{kind,url}` (not asked for, validated as is); the doc states
that kinds are not unique and that `startedAt` is 0 outside `running`.

Counts: jest 233 suites / 2432 tests passed, `tsc --noEmit` and `expo lint` clean. The release APK was not rebuilt
(the fix needed only the debug build for the instrumented test), so `apk/streamarr-tv-release-fb-local-server.apk`
predates this fix. Emulator-5590 runs the rebuilt debug build with the server up on 8080.
