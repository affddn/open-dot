import AppKit
import XCTest
@testable import open_dot_notch

/// The Slack view: the daemon's Slack state decoded, the pages it opens, and its actions, with no
/// daemon, window or Slack.
final class SlackTests: XCTestCase {
  func testDecodesTheSlackStateAndSaysTheNextStep() throws {
    let created = """
      {"config":{"state":"blocked","problem":"save a new pair"},
       "app":{"state":"created","appID":"AJOJO01","botUser":null,"problem":"waiting for this app's bot token",
              "manifestOutdated":true,"updateState":null,"updateNote":null,
              "icon":{"status":"refused","error":"not_allowed_token_type","retryAt":null}}}
      """
    let setup = try API.decode(SlackSetup.self, Data(created.utf8), log: { _ in })
    XCTAssertEqual(setup.config, SlackSetup.Config(state: "blocked", problem: "save a new pair"))
    let app = try XCTUnwrap(setup.app)
    XCTAssertEqual(app.state, "created")
    XCTAssertEqual(app.appID, "AJOJO01")
    XCTAssertTrue(app.manifestOutdated)
    XCTAssertEqual(app.icon, SlackSetup.Icon(status: "refused", error: "not_allowed_token_type"))
    XCTAssertTrue(slackSummary(setup, dot: "jojo").hasPrefix("Created. Install it in Slack"))
    let icon = slackIconLine(try XCTUnwrap(app.icon), dot: "jojo")
    XCTAssertTrue(icon.contains("not_allowed_token_type"), "The refusal names Slack's error")
    XCTAssertTrue(icon.contains("Display Information"), "and gives the manual step")

    let none = try API.decode(SlackSetup.self, Data(#"{"config":{"state":"idle","problem":null},"app":null}"#.utf8), log: { _ in })
    XCTAssertNil(none.app)
    XCTAssertTrue(slackSummary(none, dot: "jojo").hasPrefix("jojo has no Slack app of its own"))

    let active = try API.decode(
      SlackSetup.self,
      Data(#"{"config":{"state":"idle"},"app":{"state":"active","appID":"AJOJO01","botUser":"UBOT","manifestOutdated":false,"icon":{"status":"waiting","error":"ratelimited","retryAt":1800000000000}}}"#.utf8),
      log: { _ in })
    XCTAssertEqual(slackSummary(active, dot: "jojo"), "Connected as <@UBOT>. Invite it to a channel with /invite @jojo, then mention it there, or DM it.")
    XCTAssertEqual(slackIconLine(try XCTUnwrap(active.app?.icon), dot: "jojo"), "Slack is rate limiting icon changes. The daemon tries again on its own once Slack allows.")

    // A missing field is reported by its path only.
    var logged: [String] = []
    XCTAssertThrowsError(try API.decode(SlackSetup.self, Data(#"{"config":{"state":"idle"},"app":{"state":"created"}}"#.utf8), log: { logged.append($0) }))
    XCTAssertEqual(logged, ["open-dot-notch: couldn't decode SlackSetup at app.manifestOutdated (keyNotFound)"])
  }

  func testOpensOnlySlackAppPagesForAnAppIDOfSlacksForm() throws {
    let links = try XCTUnwrap(slackLinks("AJOJO01"))
    XCTAssertEqual(links.install.absoluteString, "https://api.slack.com/apps/AJOJO01/install-on-team")
    XCTAssertEqual(links.general.absoluteString, "https://api.slack.com/apps/AJOJO01/general")
    XCTAssertEqual(links.oauth.absoluteString, "https://api.slack.com/apps/AJOJO01/oauth")
    for page in [links.install, links.general, links.oauth] { XCTAssertTrue(isSlackAppPage(page)) }
    for bad in [nil, "", "ajojo01", "A12", "AJOJO01/../../x", "AJOJO01?x=1", "AJOJO01@evil.com", "A\(String(repeating: "B", count: 40))"] {
      XCTAssertNil(slackLinks(bad), "\(bad ?? "nil")")
    }
    for url in ["http://api.slack.com/apps/A1", "https://evil.com/apps/A1", "https://api.slack.com.evil.com/apps/A1",
                "https://user@api.slack.com/apps/A1", "https://api.slack.com:8443/apps/A1", "https://api.slack.com/other"] {
      XCTAssertFalse(isSlackAppPage(try XCTUnwrap(URL(string: url))), url)
    }
  }

  func testOffersAttachWithoutAnAppAndUpdateToSettleAnEarlierOne() {
    for state in [nil, "requested", "failed", "unknown", "attaching"] { XCTAssertTrue(slackCanAttach(state), "\(state ?? "nil")") }
    for state in ["creating", "created", "active"] { XCTAssertFalse(slackCanAttach(state), state) }
    let current = SlackSetup.App(state: "active", appID: "AJOJO01", manifestOutdated: false)
    XCTAssertFalse(slackCanUpdate(current))
    XCTAssertTrue(slackCanUpdate(SlackSetup.App(state: "active", appID: "AJOJO01", manifestOutdated: true)))
    XCTAssertTrue(slackCanUpdate(SlackSetup.App(state: "active", appID: "AJOJO01", manifestOutdated: false, updateState: "unknown")))
    XCTAssertTrue(slackCanUpdate(SlackSetup.App(state: "active", appID: "AJOJO01", manifestOutdated: false, updateNote: "Reinstall the app")))
    let unknown = slackIconLine(SlackSetup.Icon(status: "refused", error: "unknown_outcome"), dot: "jojo")
    XCTAssertTrue(unknown.contains("never sent again on its own"))
  }

  @MainActor func testRetryingAnUnknownCreateNeedsTheOwnerToSayThereIsNoApp() async throws {
    let store = try isolatedStore()
    var sent: [SlackAction] = []
    store.slackRead = { _ in SlackSetup(config: .init(state: "idle")) }
    store.slackSend = { _, action in
      sent.append(action)
      return .view(SlackSetup(config: .init(state: "idle")))
    }
    var asked = 0
    store.confirmSlackRetry = { _ in
      asked += 1
      return asked > 1
    }
    store.retryCreate("jojo")
    XCTAssertEqual(asked, 1)
    XCTAssertEqual(sent, [])
    store.retryCreate("jojo")
    await eventually { !store.slackBusy.contains("jojo") && sent.count == 1 }
    XCTAssertEqual(sent, [.connect(retry: true)])
  }

  @MainActor func testSlackIsTheMenusFifthItemAndAnUpdateIsSentOnlyOnceApproved() async throws {
    let store = try isolatedStore()
    let view = SlackSetup(config: .init(state: "idle"), app: .init(state: "active", appID: "AJOJO01", manifestOutdated: true))
    var reads = 0
    var sent: [SlackAction] = []
    var approved: [[String]] = []
    store.slackRead = { _ in
      reads += 1
      return view
    }
    store.slackSend = { _, action in
      sent.append(action)
      if case .update(approve: nil) = action { return .confirm(["bot events: app_home_opened"]) }
      if case .update(.some(_)) = action { return .said("Updated jojo's app.") }
      return .view(view)
    }
    store.approveSlackUpdate = { _, changes in
      approved.append(changes)
      return approved.count > 1
    }

    let menu = dotMenu(store, dot: "jolyne")
    XCTAssertEqual(menu.items.last?.identifier?.rawValue, "dot-menu-slack")
    let item = try XCTUnwrap(menu.items.last)
    XCTAssertTrue(NSApplication.shared.sendAction(try XCTUnwrap(item.action), to: item.target, from: item))
    await eventually { store.selected == "jolyne" && store.pane == .slack && store.slackStates["jolyne"] == view }
    XCTAssertFalse(store.showingHealth)
    XCTAssertGreaterThan(reads, 0)

    // The owner declines: nothing more is sent.
    store.runSlack("jolyne", .update(approve: nil))
    await eventually { !store.slackBusy.contains("jolyne") && store.slackNotices["jolyne"] != nil }
    XCTAssertEqual(sent, [.update(approve: nil)])
    XCTAssertEqual(store.slackNotices["jolyne"], "Nothing was changed.")

    // The owner approves: exactly the changes shown are sent.
    store.runSlack("jolyne", .update(approve: nil))
    await eventually { !store.slackBusy.contains("jolyne") && store.slackNotices["jolyne"] == "Updated jojo's app." }
    XCTAssertEqual(sent, [.update(approve: nil), .update(approve: nil), .update(approve: ["bot events: app_home_opened"])])

    // A lost answer is never resent.
    store.slackSend = { _, action in
      sent.append(action)
      throw APIError.lost
    }
    store.runSlack("jolyne", .token(kind: "bot", token: "xoxb-test"))
    await eventually { !store.slackBusy.contains("jolyne") && store.slackNotices["jolyne"]?.hasPrefix("No response") == true }
    XCTAssertEqual(sent.count, 4)
    XCTAssertFalse(store.slackNotices["jolyne"]?.contains("xoxb") ?? true)

    // A save the daemon couldn't confirm is reported as unconfirmed, never as not done.
    let unconfirmed = "Couldn't confirm the token was saved in the Keychain item open-dot-slack-jolyne-bot. It may or may not be there: check the item, or save the token again."
    store.slackSend = { _, action in
      sent.append(action)
      throw APIError.server(unconfirmed)
    }
    store.runSlack("jolyne", .token(kind: "bot", token: "xoxb-test"))
    await eventually { !store.slackBusy.contains("jolyne") && store.slackNotices["jolyne"]?.hasPrefix("Not confirmed") == true }
    XCTAssertEqual(store.slackNotices["jolyne"], "Not confirmed. \(unconfirmed)")
    XCTAssertEqual(sent.count, 5, "Never sent again on its own")
  }
}

private struct NotIsolated: Error {}

/// A store with two dots shown, whose daemon client reads `api.json` from an empty temporary
/// directory, so nothing ever reaches a real daemon.
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

@MainActor private func eventually(within limit: Duration = .seconds(3), _ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
  let end = ContinuousClock.now + limit
  while !condition() && ContinuousClock.now < end { try? await Task.sleep(for: .milliseconds(10)) }
  XCTAssertTrue(condition(), "Timed out", file: file, line: line)
}
