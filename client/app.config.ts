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
].map((name) => `./assets/fonts/${name}.ttf`);
const TV_BANNER = './assets/tv/android-banner.png';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Streamarr',
  slug: 'streamarr',
  version: '0.1.0',
  scheme: 'streamarr',
  orientation: 'default',
  userInterfaceStyle: 'dark',
  backgroundColor: SURFACE,
  icon: './assets/images/icon.png',
  ios: {
    bundleIdentifier: 'dev.streamarr.app',
    supportsTablet: true,
    infoPlist: {
      // Self-hosted servers are often reached over plain HTTP on the LAN.
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: true, NSAllowsLocalNetworking: true },
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
    './plugins/with-gradle-limits',
  ],
  experiments: {
    // The Streamarr server serves the web build under /watch (EXPO_BASE_URL=/watch).
    ...(process.env.EXPO_BASE_URL ? { baseUrl: process.env.EXPO_BASE_URL } : null),
    typedRoutes: true,
    reactCompiler: true,
  },
});
