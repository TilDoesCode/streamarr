import type { ConfigContext, ExpoConfig } from 'expo/config';

// EXPO_TV=1 retargets the iOS project to tvOS (separate prebuild). Android is TV-capable always.
const isTV = ['1', 'true'].includes((process.env.EXPO_TV ?? '').toLowerCase());

const SURFACE = '#0A0C12';
// Same names as src/theme/font-assets.ts (PostScript names, so every platform resolves the same family).
const FONT_FILES = [
  'Outfit-Bold',
  'Outfit-SemiBold',
  'Figtree-Regular',
  'Figtree-Medium',
  'Figtree-SemiBold',
  'Figtree-Bold',
  'JetBrainsMono-Medium',
  'Inter-DisplayBold',
  'Inter-Regular',
  'Inter-Medium',
  'Inter-SemiBold',
].map((name) => `./assets/fonts/${name}.ttf`);
const TV_BANNER = './assets/tv/android-banner.png';
const EAS_PROJECT_ID = '8c166cdd-50d9-47ba-9cb3-9c77ba9a7f8e';

// The release version (STREAMARR_ANDROID_VERSION, else package.json) is also Android's versionName.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- a CommonJS config plugin, shared with the build
const { releaseVersion } = require('./plugins/with-release-signing') as {
  releaseVersion: () => { version: string };
};

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Streamarr',
  slug: 'streamarr',
  owner: 'tildoescode',
  version: releaseVersion().version,
  scheme: 'streamarr',
  orientation: 'default',
  userInterfaceStyle: 'dark',
  backgroundColor: SURFACE,
  icon: './assets/images/icon.png',
  runtimeVersion: { policy: 'fingerprint' },
  updates: {
    url: `https://u.expo.dev/${EAS_PROJECT_ID}`,
    checkAutomatically: 'ON_LOAD',
    fallbackToCacheTimeout: 0,
    requestHeaders: { 'expo-channel-name': 'production' },
  },
  extra: { eas: { projectId: EAS_PROJECT_ID } },
  ios: {
    bundleIdentifier: 'dev.streamarr.app',
    supportsTablet: true,
    infoPlist: {
      // Plain HTTP to any host (LAN, Tailscale); NSAllowsLocalNetworking would make iOS ignore this key.
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: true },
    },
  },
  android: {
    package: 'dev.streamarr.app',
    adaptiveIcon: {
      backgroundColor: SURFACE,
      backgroundImage: './assets/images/android-icon-background.png',
      foregroundImage: './assets/images/android-icon-foreground.png',
      monochromeImage: './assets/images/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
  },
  locales: {
    en: './locales/native/en.json',
    de: './locales/native/de.json',
  },
  web: {
    bundler: 'metro',
    output: 'single',
    favicon: './assets/images/favicon.png',
    themeColor: SURFACE,
    backgroundColor: SURFACE,
  },
  plugins: [
    'expo-router',
    [
      'expo-splash-screen',
      {
        backgroundColor: SURFACE,
        image: './assets/images/splash-icon.png',
        imageWidth: 120,
      },
    ],
    [
      'expo-build-properties',
      {
        android: { usesCleartextTraffic: true },
      },
    ],
    ['expo-font', { fonts: FONT_FILES }],
    'expo-image',
    'expo-localization',
    // Keeps Keystore-encrypted tokens out of Android backups (they cannot be decrypted after a restore).
    ['expo-secure-store', { configureAndroidBackup: true, faceIDPermission: false }],
    [
      '@react-native-tvos/config-tv',
      {
        isTV,
        androidTVBanner: TV_BANNER,
        appleTVImages: {
          icon: './assets/tv/apple-icon-1280x768.png',
          iconSmall: './assets/tv/apple-icon-400x240.png',
          iconSmall2x: './assets/tv/apple-icon-800x480.png',
          topShelf: './assets/tv/apple-topshelf-1920x720.png',
          topShelf2x: './assets/tv/apple-topshelf-3840x1440.png',
          topShelfWide: './assets/tv/apple-topshelf-wide-2320x720.png',
          topShelfWide2x: './assets/tv/apple-topshelf-wide-4640x1440.png',
        },
      },
    ],
    ['expo-video', { supportsBackgroundPlayback: false, supportsPictureInPicture: !isTV }],
    'expo-libvlc-player',
    ['./plugins/with-android-tv', { androidTVBanner: TV_BANNER }],
    './plugins/with-android-playback',
    './plugins/with-a11y-service-cache',
    './plugins/with-baseline-profile',
    './plugins/with-gradle-limits',
    './plugins/with-release-signing',
    './plugins/with-ios-scene',
    // Android TV: the Core Server bundle ("server on this device"); STREAMARR_EMBEDDED_SERVER=0 builds without it.
    './plugins/with-embedded-server',
  ],
  experiments: {
    // The Streamarr server serves the web build under /watch (EXPO_BASE_URL=/watch).
    ...(process.env.EXPO_BASE_URL ? { baseUrl: process.env.EXPO_BASE_URL } : null),
    typedRoutes: true,
    reactCompiler: true,
  },
});
