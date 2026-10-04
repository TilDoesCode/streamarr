import ExpoModulesCore
import UIKit

// Apple TV: Menu gate, focus requests outside the React Native root view, native stack pops for links.
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

    AsyncFunction("popToScreen") { (identifier: String) -> Bool in
      return StackPop.popTo(identifier: identifier)
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
  // A sheet's content mounts before react-native-screens presents it: wait for a window, then for the transition.
  // The newest request wins: retries of an older one stop (Up shows Play, Menu then parks on the seek bar).
  private static var generation = 0

  static func run(_ target: UIView, completion: @escaping (Bool) -> Void) {
    generation += 1
    run(target, attempt: 0, generation: generation, completion: completion)
  }

  private static func run(
    _ target: UIView, attempt: Int, generation token: Int, completion: @escaping (Bool) -> Void
  ) {
    guard token == generation else { return completion(false) }
    if target.window == nil {
      guard attempt < 20 else { return completion(false) }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
        run(target, attempt: attempt + 1, generation: token, completion: completion)
      }
      return
    }
    let request = {
      guard target.window != nil, let system = UIFocusSystem.focusSystem(for: target) else {
        completion(false)
        return
      }
      // Inside React Native's root view its own preferred-focus path wins; presented sheets live outside it.
      if let root = target.ancestorNamed("RCTSurfaceHostingProxyRootView") {
        root.setValue(target, forKey: "reactPreferredFocusedView")
        root.setNeedsFocusUpdate()
        root.updateFocusIfNeeded()
      } else {
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
        if isFocused(target, in: system) { return completion(true) }
        let host = target.ancestor(of: TVFocusHostView.self)
        let movedInside = host.map { contains($0, system.focusedItem) } ?? false
        guard attempt < 20, !movedInside, token == generation else { return completion(false) }
        run(target, attempt: attempt + 1, generation: token, completion: completion)
      }
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

/// Pops a native stack to the page holding `identifier`, like Menu does (a JS pop drops pages linked in on tvOS).
enum StackPop {
  static func popTo(identifier: String) -> Bool {
    for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
      for window in scene.windows {
        guard let root = window.rootViewController, let match = find(identifier, from: root) else { continue }
        match.stack.popToViewController(match.page, animated: true)
        return true
      }
    }
    return false
  }

  private static func find(_ identifier: String, from controller: UIViewController)
    -> (stack: UINavigationController, page: UIViewController)?
  {
    if let stack = controller as? UINavigationController {
      for page in stack.viewControllers.dropLast() where page.view.descendant(identifier: identifier) != nil {
        return (stack, page)
      }
    }
    for child in controller.children + [controller.presentedViewController].compactMap({ $0 }) {
      if child.presentingViewController === controller || controller.children.contains(child),
        let match = find(identifier, from: child)
      {
        return match
      }
    }
    return nil
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

  func descendant(identifier: String) -> UIView? {
    if accessibilityIdentifier == identifier { return self }
    for subview in subviews {
      if let match = subview.descendant(identifier: identifier) { return match }
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
