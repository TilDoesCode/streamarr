// Always applies config-tv's Android mods (not only with EXPO_TV=1): one APK for Google TV and phones.
const { createRunOncePlugin } = require('expo/config-plugins');
const {
  withTVAndroidBannerImage,
} = require('@react-native-tvos/config-tv/build/withTVAndroidBannerImage');
const {
  withTVAndroidManifest,
} = require('@react-native-tvos/config-tv/build/withTVAndroidManifest');

/** @type {import('expo/config-plugins').ConfigPlugin<{ androidTVBanner: string }>} */
const withAndroidTV = (config, params) => {
  const tvParams = { androidTVBanner: params.androidTVBanner, androidTVRequired: false };
  config = withTVAndroidBannerImage(config, tvParams);
  return withTVAndroidManifest(config, tvParams);
};

module.exports = createRunOncePlugin(withAndroidTV, 'streamarr-with-android-tv', '1.0.0');
