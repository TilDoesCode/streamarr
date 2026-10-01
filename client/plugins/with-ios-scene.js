// iOS/tvOS 27 refuse to launch apps without the UIScene life cycle: adopt Expo's ExpoAppSceneDelegate.
const { createRunOncePlugin, withAppDelegate, withInfoPlist } = require('expo/config-plugins');

const WINDOW_START =
  /\n#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n\s*factory\.startReactNative\([\s\S]*?\)\n#endif\n/;

function adoptSceneDelegate(contents) {
  if (contents.includes('ExpoReactNativeFactoryProvider')) return contents;
  if (!WINDOW_START.test(contents) || !contents.includes('class AppDelegate: ExpoAppDelegate {')) {
    throw new Error('with-ios-scene: unexpected AppDelegate.swift template');
  }
  return (
    contents
      .replace(
        'class AppDelegate: ExpoAppDelegate {',
        'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {'
      )
      .replace(WINDOW_START, '\n') + '\nclass SceneDelegate: ExpoAppSceneDelegate {}\n'
  );
}

const SCENE_MANIFEST = {
  UIApplicationSupportsMultipleScenes: false,
  UISceneConfigurations: {
    UIWindowSceneSessionRoleApplication: [
      {
        UISceneConfigurationName: 'Default Configuration',
        UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate',
      },
    ],
  },
};

const withIosScene = (config) => {
  config = withAppDelegate(config, (cfg) => {
    if (cfg.modResults.language !== 'swift') {
      throw new Error('with-ios-scene: only a Swift AppDelegate is supported');
    }
    cfg.modResults.contents = adoptSceneDelegate(cfg.modResults.contents);
    return cfg;
  });
  return withInfoPlist(config, (cfg) => {
    cfg.modResults.UIApplicationSceneManifest = SCENE_MANIFEST;
    return cfg;
  });
};

module.exports = createRunOncePlugin(withIosScene, 'streamarr-with-ios-scene', '1.0.0');
module.exports.adoptSceneDelegate = adoptSceneDelegate;
