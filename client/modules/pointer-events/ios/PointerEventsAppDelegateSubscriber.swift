import ExpoModulesCore
import React

// iPad pointer hover: React Native only dispatches pointer events (pointerenter/leave) when this is on.
public class PointerEventsAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    willFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    #if os(iOS)
      RCTSetDispatchW3CPointerEvents(true)
    #endif
    return true
  }
}
