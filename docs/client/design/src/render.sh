#!/bin/sh
# Renders every mockup frame of directions.html to PNG with headless Chromium.
cd "$(dirname "$0")/.." || exit 1
CH=$(ls -d ~/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell 2>/dev/null | tail -1)
[ -x "$CH" ] || CH=$(ls ~/Library/Caches/ms-playwright/chromium_headless_shell-1228/*/chrome-headless-shell | tail -1)
mkdir -p png
for d in A B C; do for f in brand home home-web detail player phone; do
  id="$d-$f"; size=1920,1080; [ "$f" = phone ] && size=390,844
  "$CH" --headless --mute-audio --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --window-size=$size \
    --virtual-time-budget=8000 --screenshot="png/$id.png" "file://$PWD/directions.html?shot=$id" >/dev/null 2>&1
done; done
ls png
# Commit JPEGs only (png/ is git-ignored): sips -s format jpeg -s formatOptions 82 png/X.png --out jpg/X.jpg
