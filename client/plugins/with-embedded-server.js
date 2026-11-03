// Android: ships the Core Server bundle (client/embedded-server/dist, built by build.sh) so the TV app can host the server itself.
const fs = require('fs');
const path = require('path');
const {
  AndroidConfig,
  createRunOncePlugin,
  withAndroidManifest,
  withDangerousMod,
  withGradleProperties,
  withSettingsGradle,
} = require('expo/config-plugins');

const DIST = path.join(__dirname, '../embedded-server/dist/current');
const MODULE_NAME = 'embedded-server';
const BUILD_COMMAND = 'client/embedded-server/build.sh';

/** Opt out with STREAMARR_EMBEDDED_SERVER=0 (phone builds); any other value ships the bundle. */
function isEnabled(env = process.env) {
  return !['0', 'false', 'no', 'off'].includes((env.STREAMARR_EMBEDDED_SERVER ?? '').toLowerCase());
}

const PERMISSIONS = [
  'android.permission.INTERNET',
  'android.permission.ACCESS_NETWORK_STATE',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
  'android.permission.RECEIVE_BOOT_COMPLETED',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.WAKE_LOCK',
];

/** The service, receiver and provider come from the module's own manifest; only the permissions are app-level. */
function applyManifest(manifest) {
  AndroidConfig.Permissions.ensurePermissions(manifest, PERMISSIONS);
  return manifest;
}

/** Android 10+ only execs files in the APK's native library directory, which exists only with extracted (legacy) packaging. */
function applyLegacyPackaging(properties) {
  const rest = properties.filter(
    (item) => !(item.type === 'property' && item.key === 'expo.useLegacyPackaging')
  );
  rest.push({ type: 'property', key: 'expo.useLegacyPackaging', value: 'true' });
  return rest;
}

/** Without the bundle the native module must not link, so the JS contract reports `supported: false`. */
function excludeModule(settingsGradle) {
  if (settingsGradle.includes(`exclude = ['${MODULE_NAME}']`)) return settingsGradle;
  return settingsGradle.replace(
    /^([ \t]*)expoAutolinking\.useExpoModules\(\)/m,
    `$1expoAutolinking.exclude = ['${MODULE_NAME}']\n$1expoAutolinking.useExpoModules()`
  );
}

/** Reads dist/current/manifest.json and lists the files to ship. */
function readBundle(dist = DIST) {
  const manifestPath = path.join(dist, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `The embedded server bundle is missing (${manifestPath}). Run ${BUILD_COMMAND} first, or set STREAMARR_EMBEDDED_SERVER=0 for a build without the server.`
    );
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const jniDir = path.join(dist, 'jniLibs/arm64-v8a');
  const jniLibs = fs.readdirSync(jniDir).filter((name) => name.endsWith('.so'));
  const assets = ['server.zip', 'manifest.json'];
  for (const name of assets) {
    if (!fs.existsSync(path.join(dist, 'assets', name)))
      throw new Error(`Bundle file missing: assets/${name}`);
  }
  return { manifest, jniDir, jniLibs, assetsDir: path.join(dist, 'assets'), assets };
}

/** Copies the prebuilt bundle into the app module: jniLibs/arm64-v8a (exec'd binaries) and assets/embedded-server. */
function copyBundle(platformRoot, dist = DIST) {
  const bundle = readBundle(dist);
  const jniTarget = path.join(platformRoot, 'app/src/main/jniLibs/arm64-v8a');
  const assetTarget = path.join(platformRoot, 'app/src/main/assets/embedded-server');
  fs.mkdirSync(jniTarget, { recursive: true });
  fs.mkdirSync(assetTarget, { recursive: true });
  const copied = [];
  for (const name of bundle.jniLibs) {
    fs.copyFileSync(path.join(bundle.jniDir, name), path.join(jniTarget, name));
    copied.push(path.join(jniTarget, name));
  }
  for (const name of bundle.assets) {
    fs.copyFileSync(path.join(bundle.assetsDir, name), path.join(assetTarget, name));
    copied.push(path.join(assetTarget, name));
  }
  return { bundleVersion: bundle.manifest.bundleVersion, copied };
}

const withEmbeddedServer = (config) => {
  if (!isEnabled()) {
    return withSettingsGradle(config, (mod) => {
      mod.modResults.contents = excludeModule(mod.modResults.contents);
      return mod;
    });
  }
  config = withAndroidManifest(config, (mod) => {
    mod.modResults = applyManifest(mod.modResults);
    return mod;
  });
  config = withGradleProperties(config, (mod) => {
    mod.modResults = applyLegacyPackaging(mod.modResults);
    return mod;
  });
  // The bundle check lives here so only an Android prebuild fails without it (web exports evaluate plugins too).
  return withDangerousMod(config, [
    'android',
    (mod) => {
      copyBundle(mod.modRequest.platformProjectRoot);
      return mod;
    },
  ]);
};

module.exports = createRunOncePlugin(withEmbeddedServer, 'streamarr-with-embedded-server', '1.0.0');
module.exports.isEnabled = isEnabled;
module.exports.applyManifest = applyManifest;
module.exports.applyLegacyPackaging = applyLegacyPackaging;
module.exports.excludeModule = excludeModule;
module.exports.readBundle = readBundle;
module.exports.copyBundle = copyBundle;
module.exports.PERMISSIONS = PERMISSIONS;
module.exports.DIST = DIST;
