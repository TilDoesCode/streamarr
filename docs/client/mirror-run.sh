#!/bin/sh
# Mirrors a workflow run's temp transcript dir + script into docs/client/runs/<runId>/ until a stop file appears.
SRC="$1"; SCRIPT="$2"; RUN="$3"; DEST="$(cd "$(dirname "$0")" && pwd)/runs/$RUN"
mkdir -p "$DEST"
while [ ! -f "$DEST/.stop" ]; do
  [ -d "$SRC" ] && rsync -a "$SRC/" "$DEST/transcript/" 2>/dev/null
  [ -f "$SCRIPT" ] && cp "$SCRIPT" "$DEST/script.js" 2>/dev/null
  sleep 30
done
