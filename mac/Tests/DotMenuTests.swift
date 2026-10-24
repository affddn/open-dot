import AppKit
import SwiftUI
import XCTest
@testable import open_dot_notch

/// A dot tab's menu, the way back to the chat and the view shortcuts, driven in process: menu
/// items are sent their own actions and keys are built as events, with no window shown.
final class DotMenuTests: XCTestCase {
  @MainActor func testExpandedTabContextClickMatchesOnlyTheClickedDot() async throws {
    _ = NSApplication.shared
    let store = try isolatedStore()
    store.dots = ["jotaro", "jolyne"].map { Dot(name: $0, purpose: nil, busy: false, workers: []) }
    store.selected = "jotaro"
    for name in ["jotaro", "jolyne"] { store.instructions[name] = draft("mine") }
    let hosting = NSHostingView(rootView: ExpandedView(store: store, topInset: 32))
    let window = NSWindow(contentRect: NSRect(origin: .zero, size: expandedSize), styleMask: [.borderless], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = hosting
    defer { window.contentView = nil; window.close() }
    hosting.frame = NSRect(origin: .zero, size: expandedSize)
    hosting.layoutSubtreeIfNeeded()
    await eventually {
      hosting.layoutSubtreeIfNeeded()
      return menuAnchors(in: hosting).filter { $0.id.hasPrefix("dot-menu-") }.count == 2
    }
    XCTAssertFalse(window.isVisible, "This test must never show its window")
    for expected in ["jotaro", "jolyne"] {
      for (type, flags) in [(NSEvent.EventType.rightMouseDown, NSEvent.ModifierFlags()), (.leftMouseDown, .control)] {
        for (id, pane) in [("dot-menu-memory", Store.Pane.memory), ("dot-menu-instructions", .instructions), ("dot-menu-library", .library), ("dot-menu-health", .health), ("dot-menu-slack", .slack)] {
          store.openDot(expected == "jotaro" ? "jolyne" : "jotaro", .chat)
          hosting.layoutSubtreeIfNeeded()
          // Pane changes can move or rebuild tabs. Never reuse an anchor or point from a previous pane.
          do {
            let clicked = try XCTUnwrap(menuAnchors(in: hosting).first { $0.id == "dot-menu-\(expected)" })
            let rect = clicked.convert(clicked.bounds, to: nil)
            let point = NSPoint(x: rect.midX, y: rect.midY)
            let event = try XCTUnwrap(NSEvent.mouseEvent(with: type, location: point, modifierFlags: flags, timestamp: 0,
              windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1))
            let resolved = try XCTUnwrap(MenuAnchorView.anchor(for: event))
            print("ISSUE49 case=\(expected)/\(type.rawValue)/\(id) identity=\(ObjectIdentifier(clicked)) windowMatches=\(clicked.window === window) bounds=\(clicked.bounds) windowBounds=\(rect) resolved=\(resolved.id)")
            XCTAssertTrue(resolved === clicked, "Only the clicked tab may resolve, regardless of weak registry order")
            guard resolved === clicked else { continue }
            try choose(resolved.makeMenu(resolved), id)
          }
          await eventually { store.selected == expected && store.pane == pane }
          XCTAssertFalse(store.showingFeed)
        }
      }
    }
    XCTAssertFalse(window.isVisible)
  }

  @MainActor func testContextResolverExcludesNonContextAndUnavailableContent() throws {
    _ = NSApplication.shared
    let store = try isolatedStore()
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 200, height: 100), styleMask: [.borderless], backing: .buffered, defer: false)
    let other = NSWindow(contentRect: window.frame, styleMask: [.borderless], backing: .buffered, defer: false)
    for each in [window, other] { each.isReleasedWhenClosed = false }
    defer { window.contentView = nil; window.close(); other.close() }
    let parent = NSView(frame: NSRect(x: 20, y: 20, width: 160, height: 40))
    parent.clipsToBounds = true
    window.contentView?.addSubview(parent)
    let anchor = MenuAnchorView(frame: NSRect(x: 0, y: 0, width: 100, height: 40))
    anchor.store = store
    anchor.clipsToBounds = false
    parent.addSubview(anchor)
    func event(_ point: NSPoint, type: NSEvent.EventType = .rightMouseDown, in target: NSWindow? = nil) throws -> NSEvent {
      try XCTUnwrap(NSEvent.mouseEvent(with: type, location: anchor.convert(point, to: nil), modifierFlags: [], timestamp: 0,
        windowNumber: (target ?? window).windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1))
    }
    let inside = NSPoint(x: 10, y: 10)
    let valid = try event(inside)
    XCTAssertTrue(MenuAnchorView.anchor(for: valid) === anchor, "The fixture must resolve visible content")
    XCTAssertNil(MenuAnchorView.anchor(for: try event(inside, type: .leftMouseDown)), "Ordinary clicks keep their handlers")
    let outside = NSPoint(x: 120, y: 10)
    XCTAssertTrue(anchor.visibleRect.contains(outside), "Exercise visibleRect extending beyond own bounds")
    XCTAssertFalse(anchor.bounds.contains(outside))
    XCTAssertNil(MenuAnchorView.anchor(for: try event(outside)), "Outside own bounds is not this anchor")
    parent.setFrameSize(NSSize(width: 60, height: 40))
    let clipped = NSPoint(x: 80, y: 10)
    XCTAssertTrue(anchor.bounds.contains(clipped))
    XCTAssertFalse(anchor.visibleRect.contains(clipped), "The fixture must partially clip the anchor")
    XCTAssertTrue(MenuAnchorView.anchor(for: valid) === anchor, "The unclipped portion still resolves")
    XCTAssertNil(MenuAnchorView.anchor(for: try event(clipped)), "Clipped content is unavailable")
    parent.isHidden = true
    XCTAssertNil(MenuAnchorView.anchor(for: valid), "A hidden ancestor excludes the anchor")
    parent.isHidden = false
    XCTAssertNil(MenuAnchorView.anchor(for: try event(inside, in: other)), "Another event window cannot resolve this anchor")
    anchor.removeFromSuperview()
    XCTAssertNil(anchor.window)
    XCTAssertNil(MenuAnchorView.anchor(for: valid), "A detached anchor leaves the registry")
    XCTAssertFalse(window.isVisible)
    XCTAssertFalse(other.isVisible)
  }

  @MainActor func testMenuActionsSelectTheDotFirstThenShowItsView() async throws {
    let store = try isolatedStore()
    store.instructions["jolyne"] = draft("mine")

    let menu = dotMenu(store, dot: "jolyne")
    XCTAssertEqual(menu.items.map(\.title), ["Memory", "Instructions •", "Library", "Health", "Connectors"], "Unsaved instructions are marked")
    XCTAssertEqual(try item(menu, "dot-menu-connectors").submenu?.items.map(\.title), ["Slack"], "Slack is under Connectors")
    XCTAssertEqual(try item(menu, "dot-menu-instructions").accessibilityLabel(), "Instructions, unsaved changes")
    try choose(menu, "dot-menu-instructions")
    await eventually { store.selected == "jolyne" && store.pane == .instructions }
    XCTAssertFalse(store.showingFeed)

    let other = dotMenu(store, dot: "jojo")
    XCTAssertEqual(other.items.map(\.title), ["Memory", "Instructions", "Library", "Health", "Connectors"])
    try choose(other, "dot-menu-memory")
    await eventually { store.selected == "jojo" && store.pane == .memory }
    XCTAssertEqual(store.instructions["jolyne"]?.draft, "mine", "Switching dots keeps the draft")

    // A click on a tab selects that dot and shows its chat, whatever was shown.
    store.openDot("jolyne", .chat)
    XCTAssertEqual(store.selected, "jolyne")
    XCTAssertEqual(store.pane, .chat)
  }

  @MainActor func testMenuViewsKeepChatUnreadUntilChatIsOpened() async throws {
    for (id, pane) in [("dot-menu-memory", Store.Pane.memory), ("dot-menu-instructions", .instructions), ("dot-menu-library", .library), ("dot-menu-health", .health), ("dot-menu-slack", .slack)] {
      let store = try isolatedStore()
      store.instructions["jolyne"] = draft("mine")
      var time = 1.0
      store.latestPage = { name in
        let message = Message(id: "msg_\(Int(time))", sessionID: "ses_\(name)", kind: "dot", peer: nil,
          text: "Unread reply", tools: [], attachments: [], feed: nil, time: time, reactions: [])
        return MessagePage(messages: [message], sessionID: "ses_\(name)", next: nil, pending: [], recentEmojis: nil)
      }
      store.expanded = false
      for name in ["jojo", "jolyne"] { await store.refreshMessages(name) }
      XCTAssertFalse(store.unread("jolyne"), "The first read establishes the baseline")
      time = 2
      for name in ["jojo", "jolyne"] { await store.refreshMessages(name) }
      XCTAssertTrue(store.unread("jolyne"))
      XCTAssertTrue(store.unread("jojo"))
      store.expanded = true

      try choose(dotMenu(store, dot: "jolyne"), id)
      await eventually { store.selected == "jolyne" && store.pane == pane }
      XCTAssertTrue(store.unread("jolyne"), "Opening \(pane) must not mark cached chat read")
      await store.refreshMessages("jolyne")
      XCTAssertTrue(store.unread("jolyne"), "Refreshing while \(pane) is shown must not mark chat read")
      XCTAssertTrue(store.unread("jojo"), "The other dot stays unread")

      store.openDot("jolyne", .chat)
      XCTAssertFalse(store.unread("jolyne"), "Opening the chat marks it read")
      await store.refreshMessages("jolyne")
      XCTAssertFalse(store.unread("jolyne"))
      XCTAssertTrue(store.unread("jojo"), "Reading this dot must not mark another dot read")
    }
  }

  @MainActor func testBackToChatKeepsTheSelectedDotAndDraft() throws {
    let store = try isolatedStore()
    store.instructions["jolyne"] = draft("mine")
    for pane in [Store.Pane.memory, .instructions, .library, .health] {
      store.openDot("jolyne", pane)
      // The header's Back to chat button calls this exact action.
      store.show(.chat)
      XCTAssertEqual(store.pane, .chat)
      XCTAssertEqual(store.selected, "jolyne")
      XCTAssertFalse(store.showingFeed)
      XCTAssertEqual(store.instructions["jolyne"]?.draft, "mine")
      XCTAssertEqual(store.instructions["jolyne"]?.dirty, true)
      XCTAssertEqual(store.unsavedInstructions, ["jolyne"])
    }
  }

  @MainActor func testEscapeGoesBackToTheChatAndKeepsTheDraft() async throws {
    let store = try isolatedStore()
    store.instructions["jolyne"] = draft("mine")
    store.openDot("jolyne", .instructions)
    let escape = try key("\u{1b}", code: 53)

    XCTAssertFalse(store.navigate(escape, composing: true), "An input method's Escape is its own")
    XCTAssertEqual(store.pane, .instructions)
    XCTAssertTrue(store.navigate(escape, composing: false))
    XCTAssertEqual(store.pane, .chat)
    XCTAssertEqual(store.selected, "jolyne")
    XCTAssertEqual(store.instructions["jolyne"]?.draft, "mine")
    XCTAssertEqual(store.instructions["jolyne"]?.dirty, true)
    XCTAssertEqual(store.unsavedInstructions, ["jolyne"], "Quitting still asks")
    XCTAssertFalse(store.navigate(escape, composing: false), "In the chat, Escape is left to the chat")

    store.openDot("jolyne", .instructions)
    XCTAssertEqual(store.instructions["jolyne"]?.draft, "mine", "Showing it again doesn't reload over the draft")

    // The panel hands its keys to the store before any view sees them. It's never shown.
    _ = NSApplication.shared
    let panel = Panel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
    panel.store = store
    panel.sendEvent(escape)
    XCTAssertEqual(store.pane, .chat)
    XCTAssertEqual(store.instructions["jolyne"]?.draft, "mine")
  }

  @MainActor func testCommandDigitsSwitchViewsOnlyWhileADotIsShown() async throws {
    let store = try isolatedStore()
    store.instructions["jojo"] = draft("mine")
    store.openDot("jojo", .chat)

    XCTAssertTrue(store.navigate(try key("2", code: 19, .command), composing: false))
    XCTAssertEqual(store.pane, .memory)
    XCTAssertTrue(store.navigate(try key("3", code: 20, .command), composing: false))
    XCTAssertEqual(store.pane, .instructions)
    XCTAssertTrue(store.navigate(try key("1", code: 18, .command), composing: false))
    XCTAssertEqual(store.pane, .chat)

    XCTAssertFalse(store.navigate(try key("2", code: 19), composing: false), "A plain digit is typing")
    XCTAssertFalse(store.navigate(try key("2", code: 19, [.command, .shift]), composing: false))
    store.openFeed()
    XCTAssertFalse(store.navigate(try key("2", code: 19, .command), composing: false), "No dot is shown")
    store.openDot("jojo", .chat)
    store.expanded = false
    XCTAssertFalse(store.navigate(try key("2", code: 19, .command), composing: false), "Folded")
    XCTAssertEqual(store.pane, .chat)
  }
}

private struct NotIsolated: Error {}

@MainActor private func menuAnchors(in view: NSView) -> [MenuAnchorView] {
  (view as? MenuAnchorView).map { [$0] } ?? view.subviews.flatMap { menuAnchors(in: $0) }
}

/// A store with two dots shown, whose daemon client reads `api.json` from an empty temporary
/// directory, so loading memory or instructions never reaches a real daemon.
@MainActor private func isolatedStore() throws -> Store {
  let previous = getenv("OPEN_DOT_HOME").map { String(cString: $0) }
  let home = FileManager.default.temporaryDirectory.appending(path: "open-dot-tests-\(UUID().uuidString)").path
  setenv("OPEN_DOT_HOME", home, 1)
  defer {
    if let previous { setenv("OPEN_DOT_HOME", previous, 1) } else { unsetenv("OPEN_DOT_HOME") }
  }
  guard ProcessInfo.processInfo.environment["OPEN_DOT_HOME"] == home else { throw NotIsolated() }
  let store = Store()
  store.latestPage = { _ in throw APIError.unreachable }
  store.dots = ["jojo", "jolyne"].map { Dot(name: $0, purpose: nil, busy: false, workers: []) }
  store.loaded = true
  store.expanded = true
  store.selected = "jojo"
  return store
}

/// Loaded AGENTS.md with unsaved edits, so showing Instructions reads nothing.
private func draft(_ text: String) -> InstructionsState {
  var state = InstructionsState()
  _ = state.beginRead(discarding: false)
  state.finishRead(.success(Instructions(content: "# dot\n", revision: "r1", canRevert: false)))
  state.edit(text)
  return state
}

/// The item with that identifier, in the menu or one of its submenus.
@MainActor private func item(_ menu: NSMenu, _ id: String) throws -> NSMenuItem {
  func find(_ menu: NSMenu) -> NSMenuItem? {
    for each in menu.items {
      if each.identifier?.rawValue == id { return each }
      if let submenu = each.submenu, let found = find(submenu) { return found }
    }
    return nil
  }
  return try XCTUnwrap(find(menu))
}

/// Sends the item's own action to its own target, as choosing it does.
@MainActor private func choose(_ menu: NSMenu, _ id: String) throws {
  let chosen = try item(menu, id)
  XCTAssertTrue(chosen.isEnabled)
  XCTAssertTrue(NSApplication.shared.sendAction(try XCTUnwrap(chosen.action), to: chosen.target, from: chosen))
}

@MainActor private func key(_ characters: String, code: UInt16, _ modifiers: NSEvent.ModifierFlags = []) throws -> NSEvent {
  try XCTUnwrap(NSEvent.keyEvent(
    with: .keyDown, location: .zero, modifierFlags: modifiers, timestamp: 0, windowNumber: 0, context: nil,
    characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code))
}

@MainActor private func eventually(within limit: Duration = .seconds(3), _ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
  let end = ContinuousClock.now + limit
  while !condition() && ContinuousClock.now < end { try? await Task.sleep(for: .milliseconds(10)) }
  XCTAssertTrue(condition(), "Timed out", file: file, line: line)
}
