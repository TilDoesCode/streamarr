# LOCAL-SERVER — "Server on this device" screens (Android TV app)

Status: in-progress

Branch `fb/client-local-server` (worktree `streamarr-wt/client-local-server`), based on `main` + the JS contract commit
(`client/modules/embedded-server/{types,index,mock}.ts`, owned by the `fb/embedded-server` branch — not modified here).

Intent: the box owner picks "use this TV as the server" in onboarding (or Settings, or the deep link
`streamarr://server/local`), starts the bundled Core Server, scans a QR code with the phone to configure it in the
web UI, then connects the app to `http://127.0.0.1:<port>` like any other server.

## Decisions

## Evidence

## Follow-ups
