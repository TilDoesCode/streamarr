// Always applies config-tv's Android mods (not only with EXPO_TV=1): one APK for Google TV and phones.
const { AndroidConfig, createRunOncePlugin, withAndroidManifest } = require('expo/config-plugins');
const {
  withTVAndroidBannerImage,
} = require('@react-native-tvos/config-tv/build/withTVAndroidBannerImage');
const {
  withTVAndroidManifest,
} = require('@react-native-tvos/config-tv/build/withTVAndroidManifest');

const STREAMYBOX_SETTINGS = 'dev.streamybox.settings';

// Dev builds: the dev menu's floating button is focusable on TV and covers the top-right content.
const withoutDevMenuButton = (config) =>
  withAndroidManifest(config, (mod) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
    AndroidConfig.Manifest.addMetaDataItemToMainApplication(
      application,
      'EXDevMenuShowFloatingActionButton',
      'false'
    );
    return mod;
  });

// Streamybox detection fallback (modules/host-system): package visibility for its settings app.
const withStreamyboxQuery = (config) =>
  withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;
    const queries = (manifest.queries ??= [{}]);
    const packages = (queries[0].package ??= []);
    if (!packages.some((entry) => entry.$['android:name'] === STREAMYBOX_SETTINGS))
      packages.push({ $: { 'android:name': STREAMYBOX_SETTINGS } });
    return mod;
  });

/** @type {import('expo/config-plugins').ConfigPlugin<{ androidTVBanner: string }>} */
const withAndroidTV = (config, params) => {
  const tvParams = { androidTVBanner: params.androidTVBanner, androidTVRequired: false };
  config = withTVAndroidBannerImage(config, tvParams);
  config = withoutDevMenuButton(config);
  config = withStreamyboxQuery(config);
  return withTVAndroidManifest(config, tvParams);
};

module.exports = createRunOncePlugin(withAndroidTV, 'streamarr-with-android-tv', '1.0.0');
