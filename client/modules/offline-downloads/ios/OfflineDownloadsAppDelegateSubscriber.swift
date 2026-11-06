import ExpoModulesCore

// Reconnects the background sessions at launch and hands iOS's completion handler to the engine.
public class OfflineDownloadsAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    #if os(iOS)
      OfflineDownloadEngine.shared.activate()
    #endif
    return true
  }

  public func application(
    _ application: UIApplication,
    handleEventsForBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void
  ) {
    #if os(iOS)
      OfflineDownloadEngine.shared.handleEvents(identifier: identifier, completionHandler: completionHandler)
    #else
      completionHandler()
    #endif
  }
}
