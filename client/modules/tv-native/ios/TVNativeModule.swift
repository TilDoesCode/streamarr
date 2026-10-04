import ExpoModulesCore
import UIKit

// Apple TV: Menu gate, focus requests outside the React Native root view, the tab bar's content scroll view.
public class TVNativeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("TVNative")

    Function("setMenuMode") { (mode: String?) in
      MenuGate.shared.mode = MenuGate.Mode(rawValue: mode ?? "") ?? .off
      DispatchQueue.main.async { MenuGate.shared.install() }
    }

    AsyncFunction("focus") { (tag: Int, promise: Promise) in
      guard let target = self.appContext?.findView(withTag: tag, ofType: UIView.self) else {
        promise.resolve(false)
        return
      }
      FocusRequest.run(target) { promise.resolve($0) }
    }.runOnQueue(.main)

    AsyncFunction("attachTabBarScroll") { (tag: Int) -> Bool in
      guard let view = self.appContext?.findView(withTag: tag, ofType: UIView.self) else { return false }
      return TabBarScroll.attach(view)
    }.runOnQueue(.main)

    AsyncFunction("detachTabBarScroll") { (tag: Int) in
      guard let view = self.appContext?.findView(withTag: tag, ofType: UIView.self) else { return }
      TabBarScroll.detach(view)
    }.runOnQueue(.main)

    AsyncFunction("debugFocus") { (tag: Int?) -> [String: Any] in
      let target = tag.flatMap { self.appContext?.findView(withTag: $0, ofType: UIView.self) }
      return FocusProbe.report(target: target)
    }.runOnQueue(.main)

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
  private let windows = NSHashTable<UIWindow>.weakObjects()
  private(set) var observed: [[String: Any]] = []

  var mode: Mode {
    get { lock.withLock { storedMode } }
    set { lock.withLock { storedMode = newValue } }
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
    switch mode {
    case .off:
      return false
    case .always:
      return true
    case .tabBar:
      return FocusProbe.focusedView(in: gestureRecognizer.view)?.isInTabBar ?? false
    case .observe:
      record(gestureRecognizer.view)
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

  // Probe: who holds focus before Menu and which controllers changed afterwards.
  private func record(_ window: UIView?) {
    var entry: [String: Any] = [
      "before": FocusProbe.chain(FocusProbe.focusedView(in: window)),
      "controllersBefore": FocusProbe.controllers(window),
      "recognizers": FocusProbe.menuRecognizers(FocusProbe.focusedView(in: window)),
    ]
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
      entry["after"] = FocusProbe.chain(FocusProbe.focusedView(in: window))
      entry["controllersAfter"] = FocusProbe.controllers(window)
      self?.observed.append(entry)
      if (self?.observed.count ?? 0) > 10 { self?.observed.removeFirst() }
    }
  }
}

/// Focus request that resolves through the focus system instead of the React Native root view.
enum FocusRequest {
  static func run(_ target: UIView, completion: @escaping (Bool) -> Void) {
    let request = {
      guard target.window != nil, let system = UIFocusSystem.focusSystem(for: target) else {
        completion(false)
        return
      }
      system.requestFocusUpdate(to: target)
      system.updateFocusIfNeeded()
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
      DispatchQueue.main.async { completion(isFocused(target, in: system)) }
    }
    if let coordinator = transitionCoordinator(for: target) {
      coordinator.animate(alongsideTransition: nil) { _ in DispatchQueue.main.async(execute: request) }
    } else {
      request()
    }
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

/// The tab bar slides away while this scroll view scrolls (tvOS reads the selected tab's content scroll view).
enum TabBarScroll {
  static func attach(_ view: UIView) -> Bool {
    guard let scrollView = view as? UIScrollView ?? view.firstDescendant(of: UIScrollView.self),
      let tab = tabChild(of: view)
    else { return false }
    tab.setContentScrollView(scrollView, for: .top)
    return true
  }

  static func detach(_ view: UIView) {
    guard let tab = tabChild(of: view) else { return }
    let scrollView = view as? UIScrollView ?? view.firstDescendant(of: UIScrollView.self)
    if tab.contentScrollView(for: .top) === scrollView { tab.setContentScrollView(nil, for: .top) }
  }

  private static func tabChild(of view: UIView) -> UIViewController? {
    var controller = view.owningViewController
    while let current = controller, !(current.parent is UITabBarController) { controller = current.parent }
    return controller
  }
}

/// Probe output for `debugFocus` (I4 S2): settles the open questions before the fixes are tuned.
enum FocusProbe {
  static func focusedView(in view: UIView?) -> UIView? {
    guard let view, let system = UIFocusSystem.focusSystem(for: view) else { return nil }
    return system.focusedItem as? UIView
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
      "focused": chain(focused),
      "controllers": controllers(window),
      "menuRecognizers": menuRecognizers(focused),
      "menuObserved": MenuGate.shared.observed,
    ]
    if let target {
      result["target"] = chain(target)
      result["targetFocused"] = FocusRequest.contains(target, focused)
      result["targetInRootView"] = target.ancestorNamed("RCTSurfaceHostingProxyRootView") != nil
      result["focusability"] = String(describing: UIFocusDebugger.checkFocusability(for: target))
      result["simulateFromTarget"] = String(describing: UIFocusDebugger.simulateFocusUpdateRequest(from: target))
      if let root = target.window?.rootViewController?.view {
        result["simulateFromRoot"] = String(describing: UIFocusDebugger.simulateFocusUpdateRequest(from: root))
      }
    }
    return result
  }
}

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

  // tvOS may draw the top tab bar with private classes; React content (RCT*/RNS*) is never part of it.
  var isInTabBar: Bool {
    var current: UIView? = self
    while let view = current {
      let name = String(describing: type(of: view))
      if name.hasPrefix("RCT") || name.hasPrefix("RNS") { return false }
      if view is UITabBar || name.contains("TabBar") { return true }
      current = view.superview
    }
    return false
  }

  func ancestorNamed(_ name: String) -> UIView? {
    var current: UIView? = self
    while let view = current {
      if String(describing: type(of: view)) == name { return view }
      current = view.superview
    }
    return nil
  }

  func firstDescendant<T: UIView>(of type: T.Type) -> T? {
    for subview in subviews {
      if let match = subview as? T { return match }
      if let match = subview.firstDescendant(of: type) { return match }
    }
    return nil
  }
}
