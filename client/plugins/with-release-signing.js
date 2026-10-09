const { createRunOncePlugin, withAppBuildGradle } = require('expo/config-plugins');

function releaseVersion(
  value = process.env.STREAMARR_ANDROID_VERSION ?? require('../package.json').version
) {
  const version = value.replace(/^v/, '');
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('STREAMARR_ANDROID_VERSION must be MAJOR.MINOR.PATCH (optional v prefix)');
  }
  const [major, minor, patch] = version.split('.').map(Number);
  const code = major * 1000000 + minor * 1000 + patch;
  if (minor > 999 || patch > 999 || !Number.isSafeInteger(code) || code < 1 || code > 2100000000) {
    throw new Error('Android versionCode out of range: minor/patch <= 999, code 1..2100000000');
  }
  return { version, code };
}

const SIGNING = `
// Streamarr release credentials stay in environment variables or Gradle properties.
def streamarrSigningNames = ['STREAMARR_ANDROID_KEYSTORE', 'STREAMARR_ANDROID_KEYSTORE_PASSWORD', 'STREAMARR_ANDROID_KEY_ALIAS', 'STREAMARR_ANDROID_KEY_PASSWORD']
def streamarrSigning = streamarrSigningNames.collectEntries { name -> [(name): providers.environmentVariable(name).orElse(providers.gradleProperty(name)).orNull] }
gradle.taskGraph.whenReady { graph ->
    if (graph.allTasks.any { it.project == project && it.name.toLowerCase().contains('release') }) {
        def missing = streamarrSigningNames.findAll { !streamarrSigning[it] }
        if (!missing.empty) throw new GradleException('Streamarr release signing requires: ' + missing.join(', ') + '. Debug signing is never used for release.')
        if (!file(streamarrSigning.STREAMARR_ANDROID_KEYSTORE).isFile()) throw new GradleException('Streamarr release keystore does not exist')
    }
}
android.signingConfigs.create('streamarrRelease') {
    if (streamarrSigning.STREAMARR_ANDROID_KEYSTORE) storeFile file(streamarrSigning.STREAMARR_ANDROID_KEYSTORE)
    storePassword streamarrSigning.STREAMARR_ANDROID_KEYSTORE_PASSWORD
    keyAlias streamarrSigning.STREAMARR_ANDROID_KEY_ALIAS
    keyPassword streamarrSigning.STREAMARR_ANDROID_KEY_PASSWORD
    storeType 'PKCS12'
}
android.buildTypes.release.signingConfig = android.signingConfigs.streamarrRelease
`;

function configureRelease(contents, value) {
  const { version, code } = releaseVersion(value);
  const marker = '\n// Streamarr release credentials';
  const original = contents.split(marker)[0];
  if (!/versionCode \d+/.test(original) || !/versionName "[^"]+"/.test(original)) {
    throw new Error('with-release-signing: unsupported Android Gradle version fields');
  }
  return (
    original
      .replace(/versionCode \d+/, `versionCode ${code}`)
      .replace(/versionName "[^"]+"/, `versionName "${version}"`) + SIGNING
  );
}

module.exports = createRunOncePlugin(
  (config) =>
    withAppBuildGradle(config, (cfg) => {
      if (cfg.modResults.language !== 'groovy')
        throw new Error('with-release-signing requires Groovy');
      cfg.modResults.contents = configureRelease(cfg.modResults.contents);
      return cfg;
    }),
  'streamarr-with-release-signing',
  '1.0.0'
);
module.exports.configureRelease = configureRelease;
module.exports.releaseVersion = releaseVersion;
