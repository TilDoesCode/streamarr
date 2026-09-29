// Always applies config-tv's Android mods (not only with EXPO_TV=1): one APK for Google TV and phones.
const { AndroidConfig, createRunOncePlugin, withAndroidManifest } = require('expo/config-plugins');
const {
  withTVAndroidBannerImage,
} = require('@react-native-tvos/config-tv/build/withTVAndroidBannerImage');
const {
  withTVAndroidManifest,
} = require('@react-native-tvos/config-tv/build/withTVAndroidManifest');

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

/** @type {import('expo/config-plugins').ConfigPlugin<{ androidTVBanner: string }>} */
const withAndroidTV = (config, params) => {
  const tvParams = { androidTVBanner: params.androidTVBanner, androidTVRequired: false };
  config = withTVAndroidBannerImage(config, tvParams);
  config = withoutDevMenuButton(config);
  return withTVAndroidManifest(config, tvParams);
};

module.exports = createRunOncePlugin(withAndroidTV, 'streamarr-with-android-tv', '1.0.0');
