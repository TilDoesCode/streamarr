import ExpoModulesCore
import UIKit

// Hardware keyboard keys for the player: a hidden first responder takes them while JS captures a group.
public class PlayerKeysModule: Module {
  private lazy var catcher = KeyCatcherView { [weak self] key, repeatCount in
    self?.sendEvent("onKey", ["key": key, "repeat": repeatCount, "time": ProcessInfo.processInfo.systemUptime * 1000])
  }

  public func definition() -> ModuleDefinition {
    Name("PlayerKeys")
    Events("onKey")

    Function("setCapture") { (groups: [String]) in
      let keys = Set(groups.flatMap { KeyCatcherView.groups[$0] ?? [] })
      DispatchQueue.main.async { self.catcher.capture(keys) }
    }

    OnDestroy {
      DispatchQueue.main.async { [catcher] in catcher.capture([]) }
    }
  }
}

final class KeyCatcherView: UIView {
  static let names: [UIKeyboardHIDUsage: String] = [
    .keyboardSpacebar: "playPause",
    .keyboardK: "playPause",
    .keyboardReturnOrEnter: "select",
    .keypadEnter: "select",
    .keyboardLeftArrow: "left",
    .keyboardRightArrow: "right",
    .keyboardUpArrow: "up",
    .keyboardDownArrow: "down",
    .keyboardJ: "rewind",
    .keyboardL: "fastForward",
    .keyboardM: "mute",
    .keyboardEscape: "escape",
  ]
  static let dpad: Set<UIKeyboardHIDUsage> = [
    .keyboardReturnOrEnter, .keypadEnter, .keyboardLeftArrow, .keyboardRightArrow, .keyboardUpArrow, .keyboardDownArrow,
  ]
  static let groups: [String: Set<UIKeyboardHIDUsage>] = [
    "dpad": dpad,
    "media": Set(names.keys).subtracting(dpad),
  ]
  private static let repeating: Set<String> = ["left", "right", "rewind", "fastForward"]

  private let onKey: (String, Int) -> Void
  private var captured: Set<UIKeyboardHIDUsage> = []
  private var held: (code: UIKeyboardHIDUsage, count: Int, timer: Timer)?

  init(onKey: @escaping (String, Int) -> Void) {
    self.onKey = onKey
    super.init(frame: .zero)
    isHidden = true
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  override var canBecomeFirstResponder: Bool { true }

  func capture(_ keys: Set<UIKeyboardHIDUsage>) {
    captured = keys
    stopRepeat()
    if keys.isEmpty {
      if isFirstResponder { resignFirstResponder() }
      return
    }
    let window = UIApplication.shared.connectedScenes
      .compactMap { ($0 as? UIWindowScene)?.keyWindow }.first
    guard let window else { return }
    if superview !== window { window.addSubview(self) }
    if !isFirstResponder { becomeFirstResponder() }
  }

  private func match(_ press: UIPress) -> (UIKeyboardHIDUsage, String)? {
    guard let key = press.key, key.modifierFlags.intersection([.command, .control, .alternate]).isEmpty,
      captured.contains(key.keyCode), let name = Self.names[key.keyCode]
    else { return nil }
    return (key.keyCode, name)
  }

  override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    var rest = Set<UIPress>()
    for press in presses {
      guard let (code, name) = match(press) else { rest.insert(press); continue }
      onKey(name, 0)
      if Self.repeating.contains(name) { startRepeat(code, name) }
    }
    if !rest.isEmpty { super.pressesBegan(rest, with: event) }
  }

  override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    released(presses)
    let rest = presses.filter { match($0) == nil }
    if !rest.isEmpty { super.pressesEnded(rest, with: event) }
  }

  override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    released(presses)
    let rest = presses.filter { match($0) == nil }
    if !rest.isEmpty { super.pressesCancelled(rest, with: event) }
  }

  private func released(_ presses: Set<UIPress>) {
    if presses.contains(where: { $0.key?.keyCode == held?.code }) { stopRepeat() }
  }

  private func startRepeat(_ code: UIKeyboardHIDUsage, _ name: String) {
    stopRepeat()
    let timer = Timer(timeInterval: 0.12, repeats: true) { [weak self] _ in
      guard let self, var current = self.held else { return }
      current.count += 1
      self.held = current
      self.onKey(name, current.count)
    }
    timer.fireDate = Date().addingTimeInterval(0.45)
    RunLoop.main.add(timer, forMode: .common)
    held = (code, 0, timer)
  }

  private func stopRepeat() {
    held?.timer.invalidate()
    held = nil
  }
}
