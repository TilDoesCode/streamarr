#!/usr/bin/env node
// Records the release's signed Android TV APK in android.json on the altstore branch; the app compares it with its own build.
import { execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';

const REPO = process.env.GITHUB_REPOSITORY || 'TilDoesCode/streamarr';
const BRANCH = 'altstore';
const FILE = 'android.json';

const require = createRequire(import.meta.url);
const { releaseVersion } = require('../plugins/with-release-signing');

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, ...opts });

const tag = process.env.GITHUB_RELEASE_TAG;
if (!tag) throw new Error('GITHUB_RELEASE_TAG is required');
const { version, code } = releaseVersion(tag);

// Same environment as the APK build (EXPO_TV=1), so this is the runtime embedded in the APK.
const runtimeVersion = JSON.parse(
  run('npx', ['expo-updates', 'runtimeversion:resolve', '--platform', 'android'], {
    env: { ...process.env, EXPO_TV: '1' },
    stdio: ['ignore', 'pipe', 'ignore'],
  })
).runtimeVersion;

const manifest = {
  version,
  versionCode: code,
  runtimeVersion,
  date: new Date().toISOString(),
  downloadURL: `https://github.com/${REPO}/releases/download/${tag}/streamarr-android-tv-${version}.apk`,
  localizedDescription: process.env.RELEASE_NOTES?.trim() || `Streamarr ${version}`,
};

let sha;
try {
  sha = JSON.parse(run('gh', ['api', `repos/${REPO}/contents/${FILE}?ref=${BRANCH}`])).sha;
} catch {
  sha = undefined;
}

run('gh', ['api', '-X', 'PUT', `repos/${REPO}/contents/${FILE}`, '--input', '-'], {
  input: JSON.stringify({
    message: `Publish Android TV ${version} (${code})`,
    branch: BRANCH,
    content: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`).toString('base64'),
    ...(sha ? { sha } : {}),
  }),
});

console.log(`✔ android.json → ${version} (${code}), runtime ${runtimeVersion}`);
