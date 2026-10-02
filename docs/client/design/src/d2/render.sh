#!/bin/sh
# Renders every D2 frame (or the ids given as arguments) to ../../png and ../../jpg with headless Chromium.
cd "$(dirname "$0")/../.." || exit 1
CH=$(ls -d ~/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell 2>/dev/null | tail -1)
mkdir -p png jpg
ids="$*"; [ -n "$ids" ] || ids=$(cut -d' ' -f1 src/d2/frames.txt)
for id in $ids; do
  size=$(grep "^$id " src/d2/frames.txt | awk '{print $2","$3}')
  "$CH" --headless --mute-audio --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --window-size=$size \
    --virtual-time-budget=6000 --screenshot="png/$id.png" "file://$PWD/detail-concept.html?shot=$id" >/dev/null 2>&1
  sips -s format jpeg -s formatOptions 82 "png/$id.png" --out "jpg/$id.jpg" >/dev/null
done
pgrep -fl chrome-headless-shell; ls jpg | grep D2- | wc -l
