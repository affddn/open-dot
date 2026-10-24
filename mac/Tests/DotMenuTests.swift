import AppKit
import XCTest
@testable import open_dot_notch

/// A dot tab's menu, the way back to the chat and the view shortcuts, driven in process: menu
/// items are sent their own actions and keys are built as events, with no window shown.
final class DotMenuTests: XCTestCase {
  @MainActor func testMenuActionsSelectTheDotFirstThenShowItsView() async throws {
    let store = try isolatedStore()
    store.instructions["jolyne"] = draft("mine")

    let menu = dotMenu(store, dot: "jolyne")
    XCTAssertEqual(menu.items.map(\.title), ["Memory", "Instructions •", "Library"], "Unsaved instructions are marked")
    XCTAssertEqual(try item(menu, "dot-menu-instructions").accessibilityLabel(), "Instructions, unsaved changes")
    try choose(menu, "dot-menu-instructions")
    await eventually { store.selected == "jolyne" && store.pane == .instructions }
    XCTAssertFalse(store.showingFeed)

    let other = dotMenu(store, dot: "jojo")
    XCTAssertEqual(other.items.map(\.title), ["Memory", "Instructions", "Library"])
    try choose(other, "dot-menu-memory")
    await eventually { store.selected == "jojo" && store.pane == .memory }
    XCTAssertEqual(store.instructions["jolyne"]?.draft, "mine", "Switching dots keeps the draft")

    // A click on a tab selects that dot and shows its chat, whatever was shown.
    store.openDot("jolyne", .chat)
    XCTAssertEqual(store.selected, "jolyne")
    XCTAssertEqual(store.pane, .chat)
  }

  @MainActor func testMenuViewsKeepChatUnreadUntilChatIsOpened() async throws {
    for (id, pane) in [("dot-menu-memory", Store.Pane.memory), ("dot-menu-instructions", .instructions), ("dot-menu-library", .library)] {
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
    for pane in [Store.Pane.memory, .instructions, .library] {
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

@MainActor private func item(_ menu: NSMenu, _ id: String) throws -> NSMenuItem {
  try XCTUnwrap(menu.items.first { $0.identifier?.rawValue == id })
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
