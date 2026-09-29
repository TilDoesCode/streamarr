#!/usr/bin/env node
// Renders placeholder icons/splash/TV art from inline SVG via chrome-headless-shell: node scripts/render-placeholder-assets.mjs [shell]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const BRAND = '#6d28d9';
const BRAND_LIGHT = '#8b5cf6';
const SURFACE = '#09090b';
const WHITE = '#ffffff';

function findChrome() {
  if (process.argv[2]) return process.argv[2];
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  const dirs = existsSync(cache)
    ? readdirSync(cache)
        .filter((d) => /^chromium_headless_shell-\d+$/.test(d))
        .sort()
        .reverse()
    : [];
  for (const d of dirs) {
    const candidate = join(cache, d, 'chrome-headless-shell-mac-arm64/chrome-headless-shell');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('chrome-headless-shell not found; pass the binary path as the first argument');
}

// Play triangle centred at (cx, cy) with the given height, optically nudged right.
function triangle(cx, cy, h, fill) {
  const w = h * 0.87;
  const x0 = cx - w / 2 + h * 0.06;
  return `<path d="M${x0} ${cy - h / 2} L${x0 + w} ${cy} L${x0} ${cy + h / 2} Z" fill="${fill}" stroke="${fill}" stroke-width="${h * 0.08}" stroke-linejoin="round"/>`;
}

function mark(x, y, size) {
  const r = size * 0.22;
  return (
    `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${r}" fill="${BRAND}"/>` +
    triangle(x + size / 2, y + size / 2, size * 0.42, WHITE)
  );
}

function wordmark(x, y, fontSize) {
  return `<text x="${x}" y="${y}" font-family="-apple-system, 'Helvetica Neue', Arial, sans-serif" font-weight="700" font-size="${fontSize}" fill="${WHITE}" dominant-baseline="central">Streamarr</text>`;
}

// Logo lockup (mark + wordmark) centred in a w x h box on the dark surface with a brand glow.
function lockup(w, h, markRatio, glow = false) {
  const size = h * markRatio;
  const fontSize = size * 0.62;
  const textWidth = fontSize * 4.9;
  const gap = size * 0.3;
  const total = size + gap + textWidth;
  const x = (w - total) / 2;
  const y = (h - size) / 2;
  return (
    `<defs><radialGradient id="g" cx="50%" cy="50%" r="70%"><stop offset="0" stop-color="${BRAND_LIGHT}" stop-opacity="0.35"/><stop offset="1" stop-color="${SURFACE}" stop-opacity="0"/></radialGradient></defs>` +
    `<rect width="${w}" height="${h}" fill="${SURFACE}"/>` +
    (glow ? `<rect width="${w}" height="${h}" fill="url(#g)"/>` : '') +
    mark(x, y, size) +
    wordmark(x + size + gap, h / 2, fontSize)
  );
}

const assets = [
  // iOS/universal icon: full-bleed square, no transparency (the OS applies the mask).
  {
    file: 'assets/images/icon.png',
    w: 1024,
    h: 1024,
    body: `<rect width="1024" height="1024" fill="${BRAND}"/>${triangle(512, 512, 440, WHITE)}`,
  },
  // Android adaptive icon layers (108dp canvas, keep the glyph inside the 66dp safe zone).
  {
    file: 'assets/images/android-icon-foreground.png',
    w: 1024,
    h: 1024,
    body: triangle(512, 512, 340, WHITE),
  },
  {
    file: 'assets/images/android-icon-monochrome.png',
    w: 1024,
    h: 1024,
    body: triangle(512, 512, 340, WHITE),
  },
  { file: 'assets/images/splash-icon.png', w: 512, h: 512, body: mark(56, 56, 400) },
  { file: 'assets/images/favicon.png', w: 48, h: 48, body: mark(0, 0, 48) },
  // Android TV banner (xhdpi 320x180) shown in the Google TV / leanback launcher.
  { file: 'assets/tv/android-banner.png', w: 320, h: 180, body: lockup(320, 180, 0.3, true) },
  // Apple TV brand assets (exact sizes required by @react-native-tvos/config-tv).
  { file: 'assets/tv/apple-icon-1280x768.png', w: 1280, h: 768, body: lockup(1280, 768, 0.2) },
  { file: 'assets/tv/apple-icon-400x240.png', w: 400, h: 240, body: lockup(400, 240, 0.2) },
  { file: 'assets/tv/apple-icon-800x480.png', w: 800, h: 480, body: lockup(800, 480, 0.2) },
  { file: 'assets/tv/apple-topshelf-1920x720.png', w: 1920, h: 720, body: lockup(1920, 720, 0.16) },
  {
    file: 'assets/tv/apple-topshelf-3840x1440.png',
    w: 3840,
    h: 1440,
    body: lockup(3840, 1440, 0.16),
  },
  {
    file: 'assets/tv/apple-topshelf-wide-2320x720.png',
    w: 2320,
    h: 720,
    body: lockup(2320, 720, 0.16),
  },
  {
    file: 'assets/tv/apple-topshelf-wide-4640x1440.png',
    w: 4640,
    h: 1440,
    body: lockup(4640, 1440, 0.16),
  },
];

const chrome = findChrome();
const work = mkdtempSync(join(tmpdir(), 'streamarr-assets-'));
try {
  for (const a of assets) {
    const html = `<!doctype html><html><head><style>html,body{margin:0;background:transparent}svg{display:block}</style></head><body><svg xmlns="http://www.w3.org/2000/svg" width="${a.w}" height="${a.h}" viewBox="0 0 ${a.w} ${a.h}">${a.body}</svg></body></html>`;
    const page = join(work, 'page.html');
    writeFileSync(page, html);
    const out = join(root, a.file);
    mkdirSync(dirname(out), { recursive: true });
    execFileSync(
      chrome,
      [
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        '--default-background-color=00000000',
        `--user-data-dir=${join(work, 'profile')}`,
        `--window-size=${a.w},${a.h}`,
        `--screenshot=${out}`,
        `file://${page}`,
      ],
      { stdio: 'ignore', timeout: 30_000 }
    );
    console.log(`${a.file} (${a.w}x${a.h})`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
