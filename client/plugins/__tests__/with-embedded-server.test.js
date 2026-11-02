const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, expect, it } = require('@jest/globals');
const {
  applyLegacyPackaging,
  applyManifest,
  copyBundle,
  excludeModule,
  isEnabled,
  readBundle,
  PERMISSIONS,
} = require('../with-embedded-server');

function fakeDist() {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'embedded-dist-'));
  fs.mkdirSync(path.join(dist, 'jniLibs/arm64-v8a'), { recursive: true });
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  for (const name of ['libstreamarr-host.so', 'libffmpeg.so', 'libffprobe.so', 'libavcodec.so'])
    fs.writeFileSync(path.join(dist, 'jniLibs/arm64-v8a', name), name);
  fs.writeFileSync(path.join(dist, 'jniLibs/arm64-v8a/notes.txt'), 'ignored');
  fs.writeFileSync(path.join(dist, 'assets/server.zip'), 'zip');
  fs.writeFileSync(
    path.join(dist, 'assets/manifest.json'),
    JSON.stringify({ bundleVersion: '0.21.0+abc' })
  );
  fs.writeFileSync(
    path.join(dist, 'manifest.json'),
    JSON.stringify({ bundleVersion: '0.21.0+abc', serverVersion: '0.21.0' })
  );
  return dist;
}

describe('with-embedded-server', () => {
  it('ships the server unless STREAMARR_EMBEDDED_SERVER opts out', () => {
    expect(isEnabled({})).toBe(true);
    expect(isEnabled({ STREAMARR_EMBEDDED_SERVER: '1' })).toBe(true);
    expect(isEnabled({ STREAMARR_EMBEDDED_SERVER: '0' })).toBe(false);
    expect(isEnabled({ STREAMARR_EMBEDDED_SERVER: 'false' })).toBe(false);
  });

  it('adds the foreground service, boot and notification permissions once', () => {
    const manifest = {
      manifest: {
        $: {},
        'uses-permission': [{ $: { 'android:name': 'android.permission.INTERNET' } }],
      },
    };
    applyManifest(manifest);
    applyManifest(manifest);
    const names = manifest.manifest['uses-permission'].map((p) => p.$['android:name']);
    expect(names).toEqual(expect.arrayContaining(PERMISSIONS));
    expect(names.filter((n) => n === 'android.permission.INTERNET')).toHaveLength(1);
    expect(names).toContain('android.permission.FOREGROUND_SERVICE_SPECIAL_USE');
  });

  it('turns on legacy jniLibs packaging so the binaries exist as files', () => {
    const gradle =
      'apply plugin: "com.android.application"\n\nandroid {\n    namespace "dev.streamarr.app"\n}\n';
    const once = applyLegacyPackaging(gradle);
    expect(once).toContain('packaging { jniLibs { useLegacyPackaging = true } }');
    expect(applyLegacyPackaging(once)).toBe(once);
  });

  it('excludes the native module from autolinking when opted out', () => {
    const settings =
      "plugins {\n  id('expo-autolinking-settings')\n}\n\nexpoAutolinking.useExpoModules()\n";
    const once = excludeModule(settings);
    expect(once).toContain(
      "expoAutolinking.exclude = ['embedded-server']\nexpoAutolinking.useExpoModules()"
    );
    expect(excludeModule(once)).toBe(once);
  });

  it('fails prebuild with a clear message when the bundle was not built', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'embedded-empty-'));
    expect(() => readBundle(empty)).toThrow(/build\.sh|STREAMARR_EMBEDDED_SERVER=0/);
  });

  it('copies the exec binaries into jniLibs/arm64-v8a and the archive into assets', () => {
    const dist = fakeDist();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-'));
    const result = copyBundle(root, dist);
    expect(result.bundleVersion).toBe('0.21.0+abc');
    const jni = fs.readdirSync(path.join(root, 'app/src/main/jniLibs/arm64-v8a')).sort();
    expect(jni).toEqual(['libavcodec.so', 'libffmpeg.so', 'libffprobe.so', 'libstreamarr-host.so']);
    const assets = fs.readdirSync(path.join(root, 'app/src/main/assets/embedded-server')).sort();
    expect(assets).toEqual(['manifest.json', 'server.zip']);
  });
});
