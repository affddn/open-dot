import AppKit
import SwiftUI

final class Panel: NSPanel {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }

  /// A secondary click or Control-click on a chat message opens its menu before anything else
  /// sees the event. Every other event, including ordinary clicks, goes on as before.
  override func sendEvent(_ event: NSEvent) {
    if MenuAnchorView.handle(event) { return }
    super.sendEvent(event)
  }
}

final class HostingView<Content: View>: NSHostingView<Content> {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class HoverView: NSView {
  var onHover: (Bool) -> Void = { _ in }

  override init(frame: NSRect) {
    super.init(frame: frame)
    addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
  }

  required init?(coder: NSCoder) { nil }

  override func mouseEntered(with event: NSEvent) { onHover(true) }
  override func mouseExited(with event: NSEvent) { onHover(false) }

  /// Pins each subview to the top center, so resizing the window only changes how much of it shows.
  override func resizeSubviews(withOldSize oldSize: NSSize) {
    for view in subviews {
      view.setFrameOrigin(NSPoint(x: (bounds.width - view.frame.width) / 2, y: bounds.height - view.frame.height))
    }
  }
}

struct Notch {
  let center: CGFloat
  let top: CGFloat
  let size: CGSize
  let radius: CGFloat

  init(_ screen: NSScreen) {
    let frame = screen.frame
    if screen.safeAreaInsets.top > 0, let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea {
      let width = frame.width - left.width - right.width
      size = CGSize(width: width, height: screen.safeAreaInsets.top)
      center = frame.minX + left.width + width / 2
      radius = 8
    } else {
      let height = max(frame.maxY - screen.visibleFrame.maxY, 24)
      size = CGSize(width: 160, height: height)
      center = frame.midX
      radius = height / 2
    }
    top = frame.maxY
  }

  func frame(expanded: Bool, indicator: Bool) -> NSRect {
    let width = expanded ? expandedSize.width : size.width + (indicator ? earWidth * 2 : 0)
    let height = expanded ? expandedSize.height : size.height
    return NSRect(x: center - width / 2, y: top - height, width: width, height: height)
  }
}

/// An accessory app shows no menu bar, but AppKit still finds Command shortcuts in its main menu.
/// Without one, Command-A, C, X, V and Z do nothing in the composer. Each item has no target, so it
/// goes to whatever has keyboard focus, such as the composer or selected chat text.
@MainActor func editMenu() -> NSMenu {
  let edit = NSMenu(title: "Edit")
  edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
  edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z").keyEquivalentModifierMask = [.command, .shift]
  edit.addItem(.separator())
  edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
  edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
  edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
  edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
  let menu = NSMenu()
  // AppKit treats the first item as the application menu, so Edit comes second.
  menu.addItem(NSMenuItem())
  menu.addItem(withTitle: "Edit", action: nil, keyEquivalent: "").submenu = edit
  return menu
}

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate {
  private let store = Store()
  private let pinned = ProcessInfo.processInfo.environment["OPEN_DOT_NOTCH_PINNED"] == "1"
  private let panel = Panel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
  private var hosting: HostingView<RootView>?
  private var notch: Notch?
  private var collapse: Task<Void, Never>?
  private var generation = 0

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
    NSApp.mainMenu = editMenu()
    panel.level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 3)
    panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.isMovable = false
    panel.hidesOnDeactivate = false
    panel.becomesKeyOnlyIfNeeded = true

    let hover = HoverView(frame: .zero)
    hover.onHover = { [weak self] inside in self?.hover(inside) }
    panel.contentView = hover
    store.expanded = pinned
    // A menu, alert or share picker hides the pointer's exit from the panel, so its end checks again.
    store.onRelease = { [weak self] in
      guard let self else { return }
      // The local `hover` view shadows the method here.
      self.hover(self.panel.frame.contains(NSEvent.mouseLocation))
    }
    screenChanged()
    panel.orderFrontRegardless()
    store.start()

    NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.screenChanged() }
    }
  }

  private func screenChanged() {
    guard let screen = NSScreen.screens.first(where: { $0.safeAreaInsets.top > 0 }) ?? NSScreen.main, let hover = panel.contentView else { return }
    let notch = Notch(screen)
    self.notch = notch
    let root = RootView(store: store, notch: notch.size, collapsedRadius: notch.radius) { [weak self] in
      self?.resize()
    }
    if let hosting {
      hosting.rootView = root
    } else {
      let hosting = HostingView(rootView: root)
      // SwiftUI always lays out the full panel. A layout that changed with the window would animate from the wrong corner.
      hosting.sizingOptions = []
      hosting.frame = NSRect(origin: .zero, size: expandedSize)
      hover.addSubview(hosting)
      hover.resizeSubviews(withOldSize: hover.bounds.size)
      self.hosting = hosting
    }
    generation += 1
    if let frame = target() { panel.setFrame(frame, display: true) }
  }

  private func target() -> NSRect? {
    notch?.frame(expanded: store.expanded, indicator: store.showsIndicator)
  }

  /// SwiftUI animates the shape, so the window grows at once and shrinks only after the shape has.
  private func resize() {
    guard let frame = target() else { return }
    generation += 1
    let current = generation
    panel.setFrame(panel.frame.union(frame), display: true)
    Task {
      try? await Task.sleep(for: .milliseconds(600))
      if current == generation, let frame = target() { panel.setFrame(frame, display: true) }
    }
  }

  private func hover(_ inside: Bool) {
    guard !pinned else { return }
    collapse?.cancel()
    if inside { return expand(true) }
    collapse = Task {
      try? await Task.sleep(for: .milliseconds(400))
      if !Task.isCancelled && !store.held { expand(false) }
    }
  }

  private func expand(_ expanded: Bool) {
    guard store.expanded != expanded else { return }
    // Ordering the panel out hands keyboard focus back to the app the owner was using.
    if !expanded && panel.isKeyWindow {
      panel.orderOut(nil)
      panel.orderFrontRegardless()
    }
    withAnimation(expanded ? .open : .close) { store.expanded = expanded }
    resize()
    if expanded { store.opened() }
  }
}

let delegate = AppDelegate()
NSApplication.shared.delegate = delegate
NSApplication.shared.run()
