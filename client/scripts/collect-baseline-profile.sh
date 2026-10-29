#!/usr/bin/env bash
# Regenerates profiles/baseline-prof.txt on an Android TV emulator: a signed-in, profileable release build of this tree must be installed.
# Usage: scripts/collect-baseline-profile.sh [serial]  (Dev World sign-in; walks the TV paths in full and lite mode, then dumps ART's profile)
set -euo pipefail
serial=${1:-${ANDROID_SERIAL:-emulator-5554}}
pkg=dev.streamarr.app
out="$(cd "$(dirname "$0")/.." && pwd)/profiles/baseline-prof.txt"
adb_() { adb -s "$serial" "$@"; }
key() { for k in "$@"; do adb_ shell input keyevent "$k"; sleep "${DELAY:-0.25}"; done; }
times() { local n=$1; shift; for _ in $(seq "$n"); do key "$@"; done; }
launch() { adb_ shell am force-stop $pkg; sleep 1; adb_ shell am start -W -n $pkg/.MainActivity >/dev/null; sleep 9; }
# Settings ▸ Performance mode: Right = Off (full UI), Left = Automatic.
mode() { launch; key DPAD_LEFT; times 5 DPAD_DOWN; key DPAD_CENTER; sleep 3; DELAY=0.2 times 32 DPAD_DOWN; sleep 1; key "$1" DPAD_CENTER; sleep 6; }
paths() {
  for _ in 1 2 3; do launch; done
  key DPAD_DOWN; DELAY=0.15 times 16 DPAD_RIGHT; DELAY=0.15 times 16 DPAD_LEFT
  DELAY=0.6 times 6 DPAD_DOWN; DELAY=0.6 times 6 DPAD_UP
  for _ in 1 2 3; do key DPAD_RIGHT DPAD_CENTER; sleep 3; key DPAD_DOWN DPAD_DOWN DPAD_UP DPAD_UP BACK; sleep 2; done
  key DPAD_DOWN DPAD_DOWN DPAD_CENTER; sleep 3; key DPAD_DOWN DPAD_RIGHT DPAD_RIGHT BACK; sleep 2
  key DPAD_LEFT
  for _ in 1 2 3 4; do key DPAD_DOWN DPAD_CENTER; sleep 3; key DPAD_RIGHT DPAD_DOWN DPAD_DOWN DPAD_RIGHT DPAD_LEFT DPAD_LEFT DPAD_LEFT; done
}
adb_ shell cmd package compile --reset $pkg >/dev/null
mode DPAD_RIGHT
paths
mode DPAD_LEFT
paths
# ART writes the collected profile on its save period (~40 s).
key HOME; sleep 70
adb_ shell cmd package dump-profiles --dump-classes-and-methods $pkg >/dev/null
# Libraries that ship their own profile (androidx, Compose) are merged by AGP anyway.
adb_ shell cat /data/misc/profman/$pkg-primary.prof.txt |
  grep -E '^[HSP]*L(com/facebook|expo|com/swmansion|com/bumptech|com/horcrux|com/th3rdwave|okhttp3|okio|kotlin|kotlinx|androidx/media3|dev/streamarr)/' |
  LC_ALL=C sort -u > "$out"
wc -l "$out"
