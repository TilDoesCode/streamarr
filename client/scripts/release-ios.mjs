#!/usr/bin/env node
// Builds the unsigned IPA on EAS, mirrors it to a GitHub release and publishes it in the AltStore/SideStore source.
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { Buffer } from 'node:buffer';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = process.env.GITHUB_REPOSITORY || 'TilDoesCode/streamarr';
const SOURCE_BRANCH = 'altstore';
const SOURCE_FILE = 'source.json';
const BUNDLE_ID = 'dev.streamarr.app';
const ICON_URL = `https://raw.githubusercontent.com/${REPO}/main/client/assets/images/icon.png`;
const TINT = '#6FB4FF';

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, ...opts });
const step = (msg) => console.log(`› ${msg}`);
const gh = (args, input) => run('gh', args, input === undefined ? {} : { input });
const output = (key, value) =>
  process.env.GITHUB_OUTPUT && appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);

function localRuntime() {
  const out = run('npx', ['expo-updates', 'runtimeversion:resolve', '--platform', 'ios'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return JSON.parse(out).runtimeVersion;
}

// EAS reads the version from package.json in the uploaded working tree.
function withReleaseVersion(fn) {
  const value = process.env.STREAMARR_RELEASE_VERSION?.trim().replace(/^v/, '');
  if (!value) return fn();
  const original = readFileSync('package.json', 'utf8');
  writeFileSync('package.json', original.replace(/"version": "[^"]+"/, `"version": "${value}"`));
  try {
    return fn();
  } finally {
    writeFileSync('package.json', original);
  }
}

function easBuild() {
  const buildId = process.env.EAS_BUILD_ID?.trim();
  if (buildId) {
    step(`Using existing EAS build ${buildId}`);
    return JSON.parse(run('eas', ['build:view', buildId, '--json']));
  }
  step('Building unsigned IPA on EAS (profile "sideload")');
  const out = run(
    'eas',
    ['build', '-p', 'ios', '-e', 'sideload', '--non-interactive', '--wait', '--json'],
    {
      stdio: ['ignore', 'pipe', 'inherit'],
    }
  );
  return JSON.parse(out)[0];
}

function readPlist(file) {
  return JSON.parse(
    run('python3', [
      '-c',
      'import json,plistlib,sys;print(json.dumps(plistlib.load(open(sys.argv[1],"rb")),default=str))',
      file,
    ])
  );
}

function readIpa(ipa, dir) {
  run('unzip', ['-q', '-o', ipa, '-d', dir]);
  const app = run('sh', ['-c', `ls -d "${dir}"/Payload/*.app`]).trim();
  const plist = readPlist(join(app, 'Info.plist'));
  const privacy = Object.fromEntries(
    Object.entries(plist).filter(([key]) => /^NS\w+UsageDescription$/.test(key))
  );
  let entitlements = [];
  try {
    const xml = run('codesign', ['-d', '--entitlements', '-', '--xml', app], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (xml.trim()) {
      writeFileSync(join(dir, 'entitlements.plist'), xml);
      entitlements = Object.keys(readPlist(join(dir, 'entitlements.plist')));
    }
  } catch {
    // Unsigned builds (and Linux runners without codesign) carry no entitlements.
  }
  const fingerprint = join(app, 'EXUpdates.bundle', 'fingerprint');
  return {
    version: plist.CFBundleShortVersionString,
    build: plist.CFBundleVersion,
    minOSVersion: plist.MinimumOSVersion,
    bundleId: plist.CFBundleIdentifier,
    runtimeVersion: existsSync(fingerprint) ? readFileSync(fingerprint, 'utf8').trim() : null,
    privacy,
    entitlements,
  };
}

function readSource() {
  try {
    const file = JSON.parse(
      gh(['api', `repos/${REPO}/contents/${SOURCE_FILE}?ref=${SOURCE_BRANCH}`])
    );
    return {
      sha: file.sha,
      json: JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')),
    };
  } catch {
    return { sha: null, json: null };
  }
}

function emptySource() {
  return {
    name: 'Streamarr',
    identifier: 'dev.streamarr.source',
    subtitle: 'Self-hosted streaming for your Jellyfin library',
    description: 'Official Streamarr builds for iPhone and iPad.',
    iconURL: ICON_URL,
    website: `https://github.com/${REPO}`,
    tintColor: TINT,
    apps: [
      {
        name: 'Streamarr',
        bundleIdentifier: BUNDLE_ID,
        developerName: 'Streamarr',
        subtitle: 'Stream your library from your own server',
        localizedDescription:
          'Streamarr plays movies and shows from your self-hosted Streamarr server on iPhone and iPad.',
        iconURL: ICON_URL,
        tintColor: TINT,
        category: 'entertainment',
        versions: [],
        appPermissions: { entitlements: [], privacy: {} },
      },
    ],
    news: [],
  };
}

function writeSource(json, sha, message) {
  const content = `${JSON.stringify(json, null, 2)}\n`;
  if (sha) {
    gh(
      ['api', '-X', 'PUT', `repos/${REPO}/contents/${SOURCE_FILE}`, '--input', '-'],
      JSON.stringify({
        message,
        branch: SOURCE_BRANCH,
        sha,
        content: Buffer.from(content).toString('base64'),
      })
    );
    return;
  }
  // First publish: the source lives on an orphan branch so main stays untouched.
  const tree = JSON.parse(
    gh(
      ['api', '-X', 'POST', `repos/${REPO}/git/trees`, '--input', '-'],
      JSON.stringify({ tree: [{ path: SOURCE_FILE, mode: '100644', type: 'blob', content }] })
    )
  );
  const commit = JSON.parse(
    gh(
      ['api', '-X', 'POST', `repos/${REPO}/git/commits`, '--input', '-'],
      JSON.stringify({ message, tree: tree.sha, parents: [] })
    )
  );
  gh(
    ['api', '-X', 'POST', `repos/${REPO}/git/refs`, '--input', '-'],
    JSON.stringify({ ref: `refs/heads/${SOURCE_BRANCH}`, sha: commit.sha })
  );
}

function remoteHasCommit(sha) {
  try {
    gh(['api', `repos/${REPO}/commits/${sha}`, '--silent']);
    return true;
  } catch {
    return false;
  }
}

const work = mkdtempSync(join(tmpdir(), 'streamarr-ios-release-'));
try {
  const { sha, json } = readSource();
  const source = json ?? emptySource();
  const app = source.apps.find((a) => a.bundleIdentifier === BUNDLE_ID);

  if (process.env.ONLY_IF_NATIVE_CHANGED === '1') {
    const runtime = localRuntime();
    const published = app.versions.find((v) => v.runtimeVersion === runtime);
    if (published) {
      console.log(
        `✔ Runtime ${runtime} already shipped in ${published.version} (${published.buildVersion}); the OTA update covers this release.`
      );
      output('native', 'false');
      process.exit(0);
    }
    step(`Native runtime ${runtime} is new, building a new IPA`);
  }

  const build = withReleaseVersion(easBuild);
  const url = build?.artifacts?.applicationArchiveUrl ?? build?.artifacts?.buildUrl;
  if (build?.status !== 'FINISHED' || !url)
    throw new Error(`EAS build ${build?.id} did not finish (status ${build?.status})`);

  step('Downloading IPA');
  const downloaded = join(work, 'download.ipa');
  run('curl', ['-fsSL', '-o', downloaded, url]);
  const meta = readIpa(downloaded, join(work, 'x'));
  if (meta.bundleId !== BUNDLE_ID) throw new Error(`Unexpected bundle id ${meta.bundleId}`);
  console.log(
    `  ${meta.bundleId} ${meta.version} (${meta.build}), iOS ${meta.minOSVersion}+, runtime ${meta.runtimeVersion}`
  );
  if (app.versions.some((v) => v.version === meta.version && v.buildVersion === meta.build)) {
    throw new Error(`${meta.version} (${meta.build}) is already in the source`);
  }

  const notes =
    process.env.RELEASE_NOTES?.trim() || `Streamarr for iOS ${meta.version}, build ${meta.build}.`;
  const releaseTag = process.env.GITHUB_RELEASE_TAG?.trim();
  const tag = releaseTag || `ios-v${meta.version}-${meta.build}`;
  const assetName = releaseTag
    ? `streamarr-ios-${meta.version}.ipa`
    : `Streamarr-${meta.version}-${meta.build}.ipa`;
  const asset = join(work, assetName);
  run('cp', [downloaded, asset]);

  if (releaseTag) {
    step(`Attaching ${assetName} to release ${tag}`);
    gh(['release', 'upload', tag, asset, '--repo', REPO, '--clobber']);
  } else {
    step(`Publishing GitHub release ${tag}`);
    const target =
      build.gitCommitHash && remoteHasCommit(build.gitCommitHash)
        ? ['--target', build.gitCommitHash]
        : [];
    gh([
      'release',
      'create',
      tag,
      asset,
      '--repo',
      REPO,
      '--title',
      `Streamarr iOS ${meta.version} (${meta.build})`,
      '--notes',
      `${notes}\n\nUnsigned IPA for AltStore/SideStore/Sideloadly. EAS build: ${build.id}`,
      '--latest=false',
      ...target,
    ]);
  }

  step('Updating AltStore source');
  app.versions.unshift({
    version: meta.version,
    buildVersion: meta.build,
    date: new Date().toISOString(),
    localizedDescription: notes,
    downloadURL: `https://github.com/${REPO}/releases/download/${tag}/${assetName}`,
    size: statSync(asset).size,
    minOSVersion: meta.minOSVersion,
    runtimeVersion: meta.runtimeVersion,
  });
  app.appPermissions = { entitlements: meta.entitlements, privacy: meta.privacy };
  writeSource(source, sha, `Publish iOS ${meta.version} (${meta.build})`);
  output('native', 'true');

  console.log(`✔ ${meta.version} (${meta.build}) published`);
  console.log(
    `  Source: https://raw.githubusercontent.com/${REPO}/${SOURCE_BRANCH}/${SOURCE_FILE}`
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
