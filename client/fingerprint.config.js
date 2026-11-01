// Version/build bumps must not change the runtime, or OTA updates would miss already installed builds.
const { SourceSkips } = require('expo/fingerprint');

/** @type {import('expo/fingerprint').Config} */
module.exports = {
  sourceSkips:
    SourceSkips.ExpoConfigVersions | SourceSkips.PackageJsonAndroidAndIosScriptsIfNotContainRun,
  // The RN Gradle plugin strips `package=` from library manifests in node_modules during the APK build.
  ignorePaths: ['node_modules/**/android/src/main/AndroidManifest.xml'],
};
