const { adoptSceneDelegate } = require('../with-ios-scene');

const TEMPLATE = `@main
class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    reactNativeFactory = factory

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
`;

describe('with-ios-scene', () => {
  it('moves the React Native start into the scene delegate', () => {
    const out = adoptSceneDelegate(TEMPLATE);
    expect(out).toContain('class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {');
    expect(out).not.toContain('UIScreen.main.bounds');
    expect(out).not.toContain('startReactNative');
    expect(out).toContain('class SceneDelegate: ExpoAppSceneDelegate {}');
    expect(out).toContain('return super.application(application');
  });

  it('is idempotent', () => {
    const once = adoptSceneDelegate(TEMPLATE);
    expect(adoptSceneDelegate(once)).toBe(once);
  });

  it('fails loudly on an unknown template', () => {
    expect(() => adoptSceneDelegate('class AppDelegate: Other {}')).toThrow(/unexpected/);
  });
});
