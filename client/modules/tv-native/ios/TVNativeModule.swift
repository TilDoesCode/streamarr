import ExpoModulesCore
import UIKit

// Apple TV: Menu gate, focus requests outside the React Native root view, native stack pops for links.
public class TVNativeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("TVNative")

    // A JS reload starts without claims: the gate must not stay armed from the previous bundle.
    OnCreate { MenuGate.shared.mode = .off }

    Function("setMenuMode") { (mode: String?) in
      MenuGate.shared.mode = MenuGate.Mode(rawValue: mode ?? "") ?? .off
      DispatchQueue.main.async { MenuGate.shared.install() }
    }

    Function("resetMenu") { MenuGate.shared.mode = .off }

    Function("lastMenuInTabBar") { MenuGate.shared.lastPressInTabBar }

    AsyncFunction("focus") { (tag: Int, promise: Promise) in
      guard let target = self.appContext?.findView(withTag: tag, ofType: UIView.self) else {
        promise.resolve(FocusRequest.Result.missed.rawValue)
        return
      }
      FocusRequest.run(target) { promise.resolve($0.rawValue) }
    }.runOnQueue(.main)

    AsyncFunction("popToScreen") { (identifier: String, count: Int) -> Bool in
      return StackPop.popTo(identifier: identifier, count: count)
    }.runOnQueue(.main)

    #if DEBUG
      AsyncFunction("debugFocus") { (tag: Int?) -> [String: Any] in
        let target = tag.flatMap { self.appContext?.findView(withTag: $0, ofType: UIView.self) }
        return FocusProbe.report(target: target)
      }.runOnQueue(.main)
    #endif

    View(TVFocusHostView.self) {}
  }
}

/// One Menu recognizer per window; JS arms it while a back handler will consume Menu.
final class MenuGate: NSObject, UIGestureRecognizerDelegate {
  enum Mode: String {
    case off = ""
    case always
    case tabBar
    case observe
  }

  static let shared = MenuGate()
  private let lock = NSLock()
  private var storedMode: Mode = .off
  private var storedInTabBar = false
  private let windows = NSHashTable<UIWindow>.weakObjects()

  var mode: Mode {
    get { lock.withLock { storedMode } }
    set { lock.withLock { storedMode = newValue } }
  }

  /// Where focus was at the last intercepted Menu (read synchronously by the JS back handlers).
  var lastPressInTabBar: Bool {
    get { lock.withLock { storedInTabBar } }
    set { lock.withLock { storedInTabBar = newValue } }
  }

  func install() {
    for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
      for window in scene.windows where !windows.contains(window) {
        let recognizer = UITapGestureRecognizer(target: self, action: #selector(menuPressed(_:)))
        recognizer.allowedPressTypes = [NSNumber(value: UIPress.PressType.menu.rawValue)]
        recognizer.allowedTouchTypes = []
        recognizer.delaysTouchesBegan = true
        recognizer.delegate = self
        window.addGestureRecognizer(recognizer)
        windows.add(window)
      }
    }
  }

  @objc private func menuPressed(_ recognizer: UITapGestureRecognizer) {
    guard recognizer.state == .ended else { return }
    NotificationCenter.default.post(
      name: Notification.Name("RCTTVNavigationEventNotification"),
      object: ["eventType": "menu", "eventKeyAction": 1]
    )
  }

  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive press: UIPress) -> Bool {
    let inTabBar = focusedView(in: gestureRecognizer.view)?.isInTabBar(of: gestureRecognizer.view) ?? false
    switch mode {
    case .off:
      return false
    case .always:
      lastPressInTabBar = inTabBar
      return true
    case .tabBar:
      lastPressInTabBar = inTabBar
      return inTabBar
    case .observe:
      #if DEBUG
        FocusProbe.record(gestureRecognizer.view)
      #endif
      return false
    }
  }

  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer,
    shouldBeRequiredToFailBy otherGestureRecognizer: UIGestureRecognizer
  ) -> Bool {
    return mode == .always || mode == .tabBar
  }

  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer,
    shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
  ) -> Bool {
    return false
  }
}

func focusedView(in view: UIView?) -> UIView? {
  guard let view, let system = UIFocusSystem.focusSystem(for: view) else { return nil }
  return system.focusedItem as? UIView
}

/// Focus request that resolves through the focus system instead of the React Native root view.
enum FocusRequest {
  enum Result: String {
    case focused
    case missed
    /// A newer request or the user's own move replaced it: the caller must not fall back.
    case cancelled
  }

  // The newest request or any directional move by the user cancels pending retries.
  private static var generation = 0
  private static var observer: NSObjectProtocol?

  static func run(_ target: UIView, completion: @escaping (Result) -> Void) {
    observeUserMoves()
    generation += 1
    run(target, attempt: 0, generation: generation, completion: completion)
  }

  private static func observeUserMoves() {
    guard observer == nil else { return }
    observer = NotificationCenter.default.addObserver(
      forName: UIFocusSystem.didUpdateNotification, object: nil, queue: .main
    ) { note in
      let context = note.userInfo?[UIFocusSystem.focusUpdateContextUserInfoKey] as? UIFocusUpdateContext
      if let heading = context?.focusHeading, !heading.isEmpty { generation += 1 }
    }
  }

  private static func run(
    _ target: UIView, attempt: Int, generation token: Int, completion: @escaping (Result) -> Void
  ) {
    guard token == generation else { return completion(.cancelled) }
    if target.window == nil {
      guard attempt < 20 else { return completion(.missed) }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
        run(target, attempt: attempt + 1, generation: token, completion: completion)
      }
      return
    }
    let request = {
      guard token == generation else { return completion(.cancelled) }
      guard target.window != nil, let system = UIFocusSystem.focusSystem(for: target) else {
        return completion(.missed)
      }
      if !preferInRootView(target) {
        system.requestFocusUpdate(to: target)
        system.updateFocusIfNeeded()
      }
      if !isFocused(target, in: system), let host = target.ancestor(of: TVFocusHostView.self) {
        host.pending = target
        if contains(host, system.focusedItem) {
          host.setNeedsFocusUpdate()
          host.updateFocusIfNeeded()
        } else {
          system.requestFocusUpdate(to: host)
          system.updateFocusIfNeeded()
        }
      }
      // A presentation that completes after the request resets focus: ask again until it holds.
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
        if isFocused(target, in: system) { return completion(.focused) }
        guard token == generation else { return completion(.cancelled) }
        guard attempt < 20 else { return completion(.missed) }
        run(target, attempt: attempt + 1, generation: token, completion: completion)
      }
    }
    // `animate` returns false and drops the completion when the transition is not animated.
    if let coordinator = transitionCoordinator(for: target),
      coordinator.animate(
        alongsideTransition: nil,
        completion: { _ in DispatchQueue.main.async(execute: request) })
    {
      return
    }
    request()
  }

  /// Inside React Native's root view its own preferred-focus path wins; false when the target is not there.
  private static func preferInRootView(_ target: UIView) -> Bool {
    guard let root = target.ancestorNamed("RCTSurfaceHostingProxyRootView"),
      root.responds(to: NSSelectorFromString("setReactPreferredFocusedView:"))
    else { return false }
    root.setValue(target, forKey: "reactPreferredFocusedView")
    root.setNeedsFocusUpdate()
    root.updateFocusIfNeeded()
    return true
  }

  static func isFocused(_ target: UIView, in system: UIFocusSystem) -> Bool {
    return contains(target, system.focusedItem)
  }

  static func contains(_ view: UIView, _ item: UIFocusItem?) -> Bool {
    guard let focused = item as? UIView else { return false }
    return focused.isDescendant(of: view)
  }

  private static func transitionCoordinator(for view: UIView) -> UIViewControllerTransitionCoordinator? {
    var controller = view.owningViewController
    while let current = controller {
      if let coordinator = current.transitionCoordinator { return coordinator }
      controller = current.parent ?? current.presentingViewController
    }
    return view.window?.rootViewController?.transitionCoordinator
  }
}

/// Pops the native stack that holds a title page back to it, like Menu does (a JS pop drops linked pages on tvOS).
enum StackPop {
  /// A page found by identifier: its innermost stack and how many pages sit above it there.
  struct Candidate {
    let stack: UINavigationController
    let page: UIViewController
    let above: Int
  }

  static func popTo(identifier: String, count: Int) -> Bool {
    var candidates: [Candidate] = []
    for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
      for window in scene.windows {
        guard let root = window.rootViewController else { continue }
        collect(identifier, from: root, into: &candidates)
      }
    }
    guard let index = choose(candidates.map(\.above), count: count) else { return false }
    let match = candidates[index]
    match.stack.popToViewController(match.page, animated: true)
    return true
  }

  /// The candidate with exactly `count` pages above it (the stack JS pops); never a page already on top.
  static func choose(_ above: [Int], count: Int) -> Int? {
    return above.firstIndex { $0 == count && $0 > 0 }
  }

  /// Every view with the identifier, attributed to the innermost stack page that owns it (not an outer stack's page).
  private static func collect(_ identifier: String, from controller: UIViewController, into result: inout [Candidate]) {
    if let stack = controller as? UINavigationController {
      for page in stack.viewControllers {
        guard let view = page.viewIfLoaded?.descendant(identifier: identifier),
          let owner = innermostPage(of: view), owner.stack === stack
        else { continue }
        let index = stack.viewControllers.firstIndex(of: owner.page) ?? 0
        result.append(Candidate(stack: stack, page: owner.page, above: stack.viewControllers.count - 1 - index))
      }
    }
    for child in controller.children { collect(identifier, from: child, into: &result) }
    if let presented = controller.presentedViewController, presented.presentingViewController === controller {
      collect(identifier, from: presented, into: &result)
    }
  }

  private static func innermostPage(of view: UIView) -> (stack: UINavigationController, page: UIViewController)? {
    var controller = view.owningViewController
    while let current = controller {
      if let stack = current.parent as? UINavigationController { return (stack, current) }
      controller = current.parent
    }
    return nil
  }
}

#if DEBUG
  /// Dev-only probe for `debugFocus` and the gate's observe mode.
  enum FocusProbe {
    private static var observed: [[String: Any]] = []

    static func record(_ window: UIView?) {
      var entry: [String: Any] = [
        "before": chain(focusedView(in: window)),
        "controllersBefore": controllers(window),
        "recognizers": menuRecognizers(focusedView(in: window)),
      ]
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
        entry["after"] = chain(focusedView(in: window))
        entry["controllersAfter"] = controllers(window)
        observed.append(entry)
        if observed.count > 10 { observed.removeFirst() }
      }
    }

    static func chain(_ view: UIView?) -> [String] {
      var names: [String] = []
      var responder: UIResponder? = view
      while let current = responder, names.count < 40 {
        let tag = (current as? UIView).map { $0.tag != 0 ? "#\($0.tag)" : "" } ?? ""
        names.append(String(describing: type(of: current)) + tag)
        responder = current.next
      }
      return names
    }

    static func controllers(_ view: UIView?) -> [String] {
      guard let root = view?.window?.rootViewController ?? (view as? UIWindow)?.rootViewController else { return [] }
      var names: [String] = []
      func walk(_ controller: UIViewController, depth: Int) {
        guard names.count < 60 else { return }
        names.append(String(repeating: " ", count: depth) + String(describing: type(of: controller)))
        controller.children.forEach { walk($0, depth: depth + 1) }
        if let presented = controller.presentedViewController, presented.presentingViewController === controller {
          names.append(String(repeating: " ", count: depth) + "presents:")
          walk(presented, depth: depth + 1)
        }
      }
      walk(root, depth: 0)
      return names
    }

    static func menuRecognizers(_ view: UIView?) -> [String] {
      var names: [String] = []
      var current: UIView? = view
      while let item = current {
        for recognizer in item.gestureRecognizers ?? []
        where recognizer.allowedPressTypes.contains(NSNumber(value: UIPress.PressType.menu.rawValue)) {
          names.append("\(type(of: recognizer)) on \(type(of: item)) enabled=\(recognizer.isEnabled)")
        }
        current = item.superview
      }
      return names
    }

    static func report(target: UIView?) -> [String: Any] {
      let window = target?.window ?? UIApplication.shared.connectedScenes
        .compactMap { ($0 as? UIWindowScene)?.keyWindow }.first
      let focused = focusedView(in: window)
      var result: [String: Any] = [
        "menuMode": MenuGate.shared.mode.rawValue,
        "menuInTabBar": MenuGate.shared.lastPressInTabBar,
        "focused": chain(focused),
        "controllers": controllers(window),
        "menuRecognizers": menuRecognizers(focused),
        "menuObserved": observed,
      ]
      if let target {
        result["target"] = chain(target)
        result["targetFocused"] = FocusRequest.contains(target, focused)
        result["targetInRootView"] = target.ancestorNamed("RCTSurfaceHostingProxyRootView") != nil
        result["focusability"] = String(describing: UIFocusDebugger.checkFocusability(for: target))
      }
      return result
    }
  }
#endif

/// Screen and sheet root: hands a pending target to UIKit's next focus update inside it.
public class TVFocusHostView: ExpoView {
  weak var pending: UIView?

  public override var preferredFocusEnvironments: [UIFocusEnvironment] {
    if let target = pending, target.window != nil {
      pending = nil
      return [target]
    }
    return super.preferredFocusEnvironments
  }
}

extension UIView {
  var owningViewController: UIViewController? {
    var responder: UIResponder? = self
    while let current = responder {
      if let controller = current as? UIViewController { return controller }
      responder = current.next
    }
    return nil
  }

  func ancestor<T: UIView>(of type: T.Type) -> T? {
    var current: UIView? = self
    while let view = current {
      if let match = view as? T { return match }
      current = view.superview
    }
    return nil
  }

  /// Inside the tab controller's own bar (by ancestry), else a private `*TabBar*` class outside React content.
  func isInTabBar(of window: UIView?) -> Bool {
    let root = ((window as? UIWindow) ?? window?.window)?.rootViewController
    if let bar = tabBars(in: root).first(where: { isDescendant(of: $0) }) {
      return bar.window != nil
    }
    var current: UIView? = self
    while let view = current {
      let name = String(describing: type(of: view))
      if name.hasPrefix("RCT") || name.hasPrefix("RNS") { return false }
      if view is UITabBar || name.contains("TabBar") { return true }
      current = view.superview
    }
    return false
  }

  private func tabBars(in controller: UIViewController?) -> [UIView] {
    guard let controller else { return [] }
    var bars: [UIView] = (controller as? UITabBarController).map { [$0.tabBar] } ?? []
    for child in controller.children { bars += tabBars(in: child) }
    if let presented = controller.presentedViewController { bars += tabBars(in: presented) }
    return bars
  }

  func ancestorNamed(_ name: String) -> UIView? {
    var current: UIView? = self
    while let view = current {
      if String(describing: type(of: view)) == name { return view }
      current = view.superview
    }
    return nil
  }

  func descendant(identifier: String) -> UIView? {
    if accessibilityIdentifier == identifier { return self }
    for subview in subviews {
      if let match = subview.descendant(identifier: identifier) { return match }
    }
    return nil
  }
}
