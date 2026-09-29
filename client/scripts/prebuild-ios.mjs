#!/usr/bin/env node
// Prebuilds ios/ for `ios` or `tvos`; only a target switch triggers a clean prebuild.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const target = process.argv[2];
if (target !== 'ios' && target !== 'tvos') {
  console.error('usage: prebuild-ios.mjs <ios|tvos>');
  process.exit(1);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const marker = join(root, 'ios', '.streamarr-target');
const current = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : null;
const clean = current !== target;

const args = ['expo', 'prebuild', '--platform', 'ios', ...(clean ? ['--clean'] : [])];
execFileSync('npx', [...args, ...process.argv.slice(3)], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, EXPO_TV: target === 'tvos' ? '1' : '0', EXPO_NO_GIT_STATUS: '1' },
});
writeFileSync(marker, `${target}\n`);
