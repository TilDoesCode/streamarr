#!/bin/sh
# Renders the Aurora brand assets from brand.html with headless Chromium (Playwright cache).
cd "$(dirname "$0")" || exit 1
CH=$(ls -d ~/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell 2>/dev/null | tail -1)
shot() { # asset width height output
  "$CH" --headless --mute-audio --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --default-background-color=00000000 --window-size="$2,$3" --virtual-time-budget=3000 \
    --screenshot="$4" "file://$PWD/brand.html?asset=$1" >/dev/null 2>&1
}
shot icon 1024 1024 ../images/icon.png
shot adaptive-fg 1024 1024 ../images/android-icon-foreground.png
shot adaptive-bg 1024 1024 ../images/android-icon-background.png
shot mono 1024 1024 ../images/android-icon-monochrome.png
shot splash 512 512 ../images/splash-icon.png
shot favicon 192 192 /tmp/streamarr-favicon.png && sips -z 48 48 /tmp/streamarr-favicon.png --out ../images/favicon.png >/dev/null
shot banner 320 180 ../tv/android-banner.png
shot tv-icon 1280 768 ../tv/apple-icon-1280x768.png
shot tv-icon 800 480 ../tv/apple-icon-800x480.png
shot tv-icon 400 240 ../tv/apple-icon-400x240.png
shot topshelf 1920 720 ../tv/apple-topshelf-1920x720.png
shot topshelf 3840 1440 ../tv/apple-topshelf-3840x1440.png
shot topshelf 2320 720 ../tv/apple-topshelf-wide-2320x720.png
shot topshelf 4640 1440 ../tv/apple-topshelf-wide-4640x1440.png
