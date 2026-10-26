# USPEED — server ↔ Usenet speed test, streaming path overview, bandwidth fit per version

Status: in-progress

Intent: worktree /Volumes/DevSSD/Development/streamarr-worktrees/usenet-speedtest (branch feat/usenet-speedtest, from 0.19.0).
User request: start a speed test from the server to the primary Usenet provider (fallback to the next one), for every
viewer (permission `AllowUsenetSpeedTest`, default on); a small "Streamarr path" overview (Usenet → server → this device)
in the app and the web admin; the Versions sheet marks versions whose bitrate does not fit the measured connection, and
the server ranks/auto-picks with that fit. Dev World 39350, Expo web 39351.

## Log
- Finding: `Config/ProviderSpeedTester` (admin) opens `MaxConnections` connections of its own on top of the live pool
  (warm-up keeps idle pool connections open), so provider-side it can exceed the account's connection limit and it
  ignores active streams.
