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

  @MainActor func testSlackIsUnderConnectorsAndAnUpdateIsSentOnlyOnceApproved() async throws {
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
    let connectors = try XCTUnwrap(menu.items.last)
    XCTAssertEqual(connectors.identifier?.rawValue, "dot-menu-connectors")
    XCTAssertEqual(connectors.title, "Connectors")
    let item = try XCTUnwrap(connectors.submenu?.items.first)
    XCTAssertEqual(item.identifier?.rawValue, "dot-menu-slack")
    XCTAssertEqual(item.title, "Slack")
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

/// The guided install's clipboard pickup, approval mark and DM check, with a fake clipboard and
/// clock, so no test reads or clears the system clipboard, opens a page or reaches Slack.
final class SlackPickupTests: XCTestCase {
  // Fake tokens of each form, built from parts so they don't read as real ones anywhere.
  private let bot = ["xoxb", "1111111111", "2222222222222", String(repeating: "a", count: 24)].joined(separator: "-")
  private let appToken = ["xapp", "1", "AJOJO01", "3333333333333", String(repeating: "b", count: 64)].joined(separator: "-")
  private let access = "xoxe.xoxp-1-" + String(repeating: "c", count: 120)
  private let refresh = "xoxe-1-" + String(repeating: "d", count: 120)

  func testTokenFormsAreWholeAndAnchored() {
    XCTAssertTrue(slackTokenMatches(.bot, bot, appID: nil))
    XCTAssertTrue(slackTokenMatches(.app, appToken, appID: "AJOJO01"))
    XCTAssertTrue(slackTokenMatches(.access, access, appID: nil))
    XCTAssertTrue(slackTokenMatches(.refresh, refresh, appID: nil))
    // Each form only for its own step.
    XCTAssertFalse(slackTokenMatches(.bot, appToken, appID: nil))
    XCTAssertFalse(slackTokenMatches(.access, refresh, appID: nil))
    XCTAssertFalse(slackTokenMatches(.refresh, access, appID: nil))
    XCTAssertFalse(slackTokenMatches(.app, appToken, appID: "AOTHER01"), "An app-level token of another app")
    XCTAssertFalse(slackTokenMatches(.app, appToken, appID: nil))
    for text in [
      " \(bot)", "\(bot) ", "\(bot)\n", "x\(bot)", "\(bot)x!", "\(bot)\n\(bot)", "token: \(bot)",
      "xoxb-test", "xoxb-1-2-short", "XOXB-1111111111-2222222222222-\(String(repeating: "a", count: 24))",
      "xoxp-1111111111-2222222222222-\(String(repeating: "a", count: 24))",
      "xoxb-1111111111-2222222222222-\(String(repeating: "a", count: 23))é", "",
    ] {
      XCTAssertFalse(slackTokenMatches(.bot, text, appID: nil), text)
    }
    XCTAssertFalse(slackTokenMatches(.refresh, "xoxe-1-" + String(repeating: "d", count: 1100), appID: nil), "Too long")
  }

  @MainActor func testOnlyACopyMadeAfterArmingIsTakenAndOnlyThatRevisionIsCleared() async throws {
    let (store, clipboard, sent) = try armedStore()
    clipboard.copy(bot)
    clipboard.copy("an unrelated note")
    store.slackPickup = nil
    // Copies before arming never count.
    store.armPickup("jojo", .bot)
    store.checkPickup()
    XCTAssertEqual(clipboard.reads, 0)
    // An unrelated copy is read once, ignored and not kept.
    clipboard.copy("dinner at 8")
    store.checkPickup()
    store.checkPickup()
    XCTAssertEqual(clipboard.reads, 1)
    XCTAssertEqual(store.slackPickup?.mismatched, true)
    XCTAssertEqual(clipboard.contents, "dinner at 8", "Only a captured copy is cleared")
    XCTAssertEqual(sent.actions, [])
    // Only the exact whole token is captured, without trimming a larger clipboard value.
    clipboard.copy("\(bot)\n")
    store.checkPickup()
    XCTAssertNotNil(store.slackPickup)
    XCTAssertEqual(sent.actions, [])
    clipboard.copy(bot)
    store.checkPickup()
    XCTAssertNil(store.slackPickup)
    XCTAssertEqual(clipboard.cleared, [clipboard.revision])
    XCTAssertNil(clipboard.contents)
    await eventually { !store.slackBusy.contains("jojo") }
    XCTAssertEqual(sent.actions, [.token(kind: "bot", token: bot)])
    XCTAssertEqual(store.slackSaved["AJOJO01"], ["bot"])
    XCTAssertFalse(slackSummary(try XCTUnwrap(store.slackStates["jojo"]), dot: "jojo").contains("Connected"), "Saved isn't connected")

    // A clipboard revision changing during the read is not captured or cleared.
    store.armPickup("jojo", .app)
    clipboard.copy(appToken)
    clipboard.afterRead = { clipboard.copy("copied later") }
    store.checkPickup()
    clipboard.afterRead = {}
    XCTAssertEqual(clipboard.contents, "copied later")
    XCTAssertNotNil(store.slackPickup)
    XCTAssertEqual(sent.actions.count, 1)
    clipboard.copy(appToken)
    store.checkPickup()
    await eventually { !store.slackBusy.contains("jojo") }
    XCTAssertEqual(sent.actions.last, .token(kind: "app", token: appToken))
    let reads = clipboard.reads
    clipboard.copy(bot)
    store.checkPickup()
    XCTAssertEqual(clipboard.reads, reads)
    XCTAssertEqual(sent.actions.count, 2)
    for notice in store.slackNotices.values { XCTAssertFalse(notice.contains("xox") || notice.contains("xapp")) }
  }

  @MainActor func testAPickupEndsOnTimeoutLeavingTheViewAnotherDotANewAppOrStop() async throws {
    let (store, clipboard, sent) = try armedStore()
    sent.now += 119
    store.checkPickup()
    XCTAssertNotNil(store.slackPickup)
    sent.now += 1
    store.checkPickup()
    XCTAssertNil(store.slackPickup)
    XCTAssertTrue(store.slackNotices["jojo"]?.contains("within 2 minutes") == true)

    let ends: [(String, @MainActor () -> Void)] = [
      ("chat", { store.show(.chat) }),
      ("feed", { store.openFeed() }),
      ("other dot", { store.openDot("jolyne", .slack) }),
      ("new app", { store.slackStates["jojo"] = created("AOTHER01") }),
      ("stop", { store.stopPickup() }),
      ("teardown", { store.endPickup(nil) }),
    ]
    for (why, end) in ends {
      store.selected = "jojo"
      store.showingFeed = false
      store.show(.slack)
      store.slackStates["jojo"] = created("AJOJO01")
      store.armPickup("jojo", .bot)
      XCTAssertEqual(store.slackPickup?.dot, "jojo", why)
      end()
      clipboard.copy(bot)
      store.checkPickup()
      XCTAssertNil(store.slackPickup, why)
    }
    XCTAssertEqual(clipboard.reads, 0, "A pickup that ended never reads")
    XCTAssertEqual(sent.actions, [])

    // One owner at a time: arming another dot's pickup replaces this one.
    store.openDot("jojo", .slack)
    store.slackStates["jojo"] = created("AJOJO01")
    store.armPickup("jojo", .bot)
    store.openDot("jolyne", .slack)
    store.armPickup("jolyne", .access)
    XCTAssertEqual(store.slackPickup?.dot, "jolyne")
    XCTAssertEqual(store.slackPickup?.step, .access)
  }

  @MainActor func testAnAccessTokenIsHeldOnlyUntilItsRefreshTokenAndDroppedOtherwise() async throws {
    let (store, clipboard, sent) = try armedStore()
    store.endPickup(nil)

    store.armPickup("jojo", .refresh)
    XCTAssertNil(store.slackPickup, "The refresh step waits for the access token")
    XCTAssertEqual(store.slackNotices["jojo"], "Pick up the access token first.")

    store.armPickup("jojo", .access)
    clipboard.copy(refresh)
    store.checkPickup()
    XCTAssertNotNil(store.slackPickup, "A refresh token isn't an access token")
    clipboard.copy(access)
    store.checkPickup()
    XCTAssertEqual(store.slackHolding, "jojo")
    XCTAssertNil(clipboard.contents)
    XCTAssertEqual(sent.actions, [], "Nothing is saved until both are")
    store.armPickup("jojo", .refresh)
    clipboard.copy(refresh)
    store.checkPickup()
    XCTAssertNil(store.heldAccess)
    XCTAssertNil(store.slackHolding)
    await eventually { !store.slackBusy.contains("jojo") }
    XCTAssertEqual(sent.actions, [.config(token: access, refreshToken: refresh)])

    // Dropped when its two minutes pass, on leaving the view, or when another step is armed.
    let drops: [(String, @MainActor () -> Void)] = [
      ("expiry", { sent.now += 120 }),
      ("navigation", { store.show(.chat) }),
      ("another step", { store.armPickup("jojo", .bot) }),
      ("stop", { store.stopPickup() }),
    ]
    for (why, drop) in drops {
      store.show(.slack)
      store.armPickup("jojo", .access)
      clipboard.copy(access)
      store.checkPickup()
      XCTAssertEqual(store.slackHolding, "jojo", why)
      drop()
      store.checkPickup()
      XCTAssertNil(store.heldAccess, why)
      XCTAssertNil(store.slackHolding, why)
      store.endPickup(nil)
    }
    XCTAssertEqual(sent.actions.count, 1, "Nothing more was saved")

    store.show(.slack)
    store.armPickup("jojo", .access)
    clipboard.copy(access)
    store.checkPickup()
    sent.now += 120
    store.armPickup("jojo", .refresh)
    XCTAssertNil(store.heldAccess, "Rearming cannot extend an expired access-token hold")
    XCTAssertNil(store.slackPickup)
  }

  @MainActor func testAFailedSaveIsReportedOnceAndAPickupWaitsWhileBusy() async throws {
    let (store, clipboard, sent) = try armedStore()
    sent.failure = APIError.server("Couldn't confirm the token was saved in the Keychain item open-dot-slack-jojo-bot. It may or may not be there: check the item, or save the token again.")
    store.slackBusy.insert("jojo")
    clipboard.copy(bot)
    store.checkPickup()
    XCTAssertEqual(clipboard.reads, 0, "Nothing is read while an action runs")
    store.slackBusy.remove("jojo")
    store.checkPickup()
    await eventually { !store.slackBusy.contains("jojo") && store.slackNotices["jojo"] != nil }
    XCTAssertTrue(store.slackNotices["jojo"]?.hasPrefix("Not confirmed.") == true)
    XCTAssertFalse(store.slackNotices["jojo"]?.contains(bot) ?? true)
    XCTAssertNil(store.slackSaved["AJOJO01"], "An unconfirmed save isn't shown as saved")
    clipboard.copy(bot)
    store.checkPickup()
    XCTAssertEqual(sent.actions.count, 1, "Never sent again on its own")

    sent.failure = APIError.lost
    store.armPickup("jojo", .bot)
    clipboard.copy(bot)
    store.checkPickup()
    await eventually { !store.slackBusy.contains("jojo") && store.slackNotices["jojo"]?.hasPrefix("No response") == true }
    XCTAssertEqual(sent.actions.count, 2)
  }

  @MainActor func testWaitingForApprovalIsTheOwnersMarkAndResumeOpensTheSameApp() throws {
    let (store, _, sent) = try armedStore()
    var opened: [URL] = []
    store.openSlackPage = { opened.append($0) }
    store.markApproval("jojo", waiting: true)
    XCTAssertEqual(store.slackApproval, ["AJOJO01"])
    let setup = try XCTUnwrap(store.slackStates["jojo"])
    XCTAssertEqual(setup.app?.state, "created", "A mark changes nothing about the app")
    XCTAssertFalse(slackSummary(setup, dot: "jojo").contains("Connected"))
    store.resumeInstall("jojo")
    XCTAssertEqual(opened.map(\.absoluteString), ["https://api.slack.com/apps/AJOJO01/install-on-team"])
    XCTAssertEqual(store.slackApproval, [])
    XCTAssertEqual(sent.actions, [])
    // Only Slack's app pages open.
    store.openSlack(try XCTUnwrap(URL(string: "https://evil.com/apps/AJOJO01")))
    store.openSlack(try XCTUnwrap(URL(string: "https://api.slack.com/apps")))
    XCTAssertEqual(opened.count, 2)
  }

  @MainActor func testALinksBotTokenWaitsForItsAppLevelTokenAndAnotherAppReplacesOnlyOnConfirmation() async throws {
    let (store, clipboard, sent) = try armedStore()
    store.endPickup(nil)
    let other = ["xapp", "1", "AOTHER01", "3333333333333", String(repeating: "b", count: 64)].joined(separator: "-")
    var asked: [String] = []
    store.confirmSlackReplace = { name, appID in
      asked.append(appID)
      if let during = sent.duringConfirm { store.slackStates[name] = during }
      return sent.confirm
    }
    let pickBoth = {
      store.armPickup("jojo", .linkBot)
      clipboard.copy(self.bot)
      store.checkPickup()
      XCTAssertEqual(store.heldAccess?.step, .linkBot)
      store.armPickup("jojo", .linkApp)
      clipboard.copy(other)
      store.checkPickup()
    }
    store.armPickup("jojo", .linkApp)
    XCTAssertNil(store.slackPickup, "The app-level step waits for the bot token")
    XCTAssertEqual(store.slackNotices["jojo"], "Pick up the bot token first.")
    // An access token held for the configuration pair isn't a link's bot token.
    store.armPickup("jojo", .access)
    clipboard.copy(access)
    store.checkPickup()
    store.armPickup("jojo", .linkApp)
    XCTAssertNil(store.slackPickup)

    // jojo has AJOJO01, so another app is sent only once the owner confirms.
    pickBoth()
    XCTAssertEqual(asked, ["AJOJO01"])
    XCTAssertNil(store.heldAccess)
    XCTAssertEqual(sent.actions, [], "Declined: nothing was sent")
    // The request names the app the owner confirmed, even if a refresh bound another while the
    // confirmation was open; the daemon then refuses it.
    sent.confirm = true
    sent.duringConfirm = created("AMIDDLE01")
    pickBoth()
    await eventually { !store.slackBusy.contains("jojo") }
    XCTAssertEqual(asked, ["AJOJO01", "AJOJO01"])
    XCTAssertEqual(sent.actions, [.link(bot: bot, app: other, replacing: "AJOJO01")])
    sent.duringConfirm = nil

    // Without an app, nothing is asked.
    sent.view = SlackSetup(config: .init(state: "idle"))
    store.slackStates["jojo"] = sent.view
    pickBoth()
    await eventually { !store.slackBusy.contains("jojo") }
    XCTAssertEqual(asked.count, 2)
    XCTAssertEqual(sent.actions.last, .link(bot: bot, app: other, replacing: nil))
    for notice in store.slackNotices.values { XCTAssertFalse(notice.contains("xox") || notice.contains("xapp")) }
  }

  @MainActor func testTheDMCheckSaysPendingUntilAConfirmedReplyAndTheFeedStaysApart() async throws {
    let old = try API.decode(SlackSetup.self, Data(#"{"config":{"state":"idle"},"app":null}"#.utf8), log: { _ in })
    XCTAssertNil(old.dmCheck)
    XCTAssertNil(old.ownerFeed)
    XCTAssertNil(old.config.saved)
    XCTAssertTrue(slackNeedsConfig(old), "An older daemon's view shows the bootstrap")
    XCTAssertFalse(slackNeedsConfig(created("AJOJO01")), "A later dot skips it")
    XCTAssertTrue(slackNeedsConfig(SlackSetup(config: .init(state: "blocked", saved: true))))
    XCTAssertTrue(slackDMCheckLine(nil, dot: "jojo").contains("not started"))
    let pending = try API.decode(
      SlackSetup.self,
      Data(#"{"config":{"state":"idle","problem":null,"saved":true},"ownerFeed":{"items":0,"latestAt":null},"dmCheck":{"state":"pending","since":1800000000000,"dmAt":null},"app":{"state":"active","appID":"AJOJO01","botUser":"UBOT","manifestOutdated":false}}"#.utf8),
      log: { _ in })
    let line = slackDMCheckLine(pending.dmCheck, dot: "jojo")
    XCTAssertTrue(line.contains("pending"))
    XCTAssertFalse(line.contains("replied"))
    XCTAssertTrue(line.contains("Nothing is sent") || line.contains("yourself"))
    XCTAssertTrue(slackDMCheckLine(.init(state: "replied", since: 1, dmAt: 2), dot: "jojo").contains("replied"))
    XCTAssertTrue(slackDMCheckLine(.init(state: "replied", since: 1, dmAt: nil), dot: "jojo").contains("pending"))
    let feed = slackOwnerFeedLine(pending.ownerFeed)
    XCTAssertTrue(feed.contains("separate from this bot"))
    XCTAssertTrue(feed.contains("doesn't check its token"))
    XCTAssertTrue(slackOwnerFeedLine(.init(items: 3, latestAt: 1_800_000_000_000)).contains("3 Slack items"))

    let (store, _, sent) = try armedStore()
    sent.view = pending
    store.runSlack("jojo", .dmCheck)
    await eventually { !store.slackBusy.contains("jojo") }
    XCTAssertEqual(sent.actions, [.dmCheck])
    XCTAssertEqual(store.slackStates["jojo"]?.dmCheck?.state, "pending")
  }

  // Issue 50: the Slack login, Retry install and the prefilled link's fallback.

  func testDecodesTheLoginTheInstallAndThePrefilledLink() throws {
    let json = #"""
      {"config":{"state":"idle","problem":null,"saved":false},"ownerFeed":{"items":0,"latestAt":null},"dmCheck":null,
       "login":{"state":"ready","team":"T1","user":"UOWNER","problem":null,"pending":null},
       "manifestLink":"https://api.slack.com/apps?new_app=1&manifest_json=%7B%7D",
       "app":{"state":"created","appID":"AJOJO01","botUser":null,"problem":"Waiting for admin approval","install":{"phase":"approval","code":"app_approval_request_eligible"},"manifestOutdated":false}}
      """#
    let setup = try API.decode(SlackSetup.self, Data(json.utf8), log: { _ in })
    XCTAssertEqual(setup.login, SlackSetup.Login(state: "ready", team: "T1", user: "UOWNER"))
    XCTAssertEqual(setup.app?.install, SlackSetup.Install(phase: "approval", code: "app_approval_request_eligible"))
    XCTAssertFalse(slackNeedsLogin(setup))
    XCTAssertTrue(slackCanRetryInstall(setup))
    let waiting = try XCTUnwrap(slackInstallLine(setup.app?.install))
    XCTAssertTrue(waiting.contains("Waiting for admin approval"))
    XCTAssertTrue(waiting.contains("hasn't asked"), "It never says approval was requested")
    XCTAssertTrue(slackSummary(setup, dot: "jojo").hasPrefix("Created. Waiting for admin approval"))
    XCTAssertEqual(slackManifestURL(setup)?.host, "api.slack.com")

    // Nothing to retry while one is in flight, without a login, or once connected.
    var busy = setup
    busy.app?.install = .init(phase: "sending")
    XCTAssertFalse(slackCanRetryInstall(busy))
    var out = setup
    out.login = .init(state: "relogin", problem: "refreshing the Slack login was interrupted")
    XCTAssertTrue(slackNeedsLogin(out))
    XCTAssertFalse(slackCanRetryInstall(out))
    XCTAssertTrue(slackLoginLine(try XCTUnwrap(out.login)).contains("interrupted"))
    XCTAssertTrue(slackInstallLine(.init(phase: "saved"))?.contains("Saved isn't connected") == true)
    XCTAssertNil(slackInstallLine(nil))

    // An older daemon has no login, so the view offers none and keeps the configuration tokens.
    let old = try API.decode(SlackSetup.self, Data(#"{"config":{"state":"idle"},"app":null}"#.utf8), log: { _ in })
    XCTAssertNil(old.login)
    XCTAssertFalse(slackNeedsLogin(old))
    XCTAssertNil(slackManifestURL(old))
    // Only Slack's own app pages open.
    var evil = setup
    evil.manifestLink = "https://evil.com/apps?new_app=1"
    XCTAssertNil(slackManifestURL(evil))
  }

  func testTheLinksTokensNameTheirAppAndTheLinkWarnsOfADuplicate() {
    let bot = ["xoxb", "1111111111", "2222222222222", String(repeating: "a", count: 24)].joined(separator: "-")
    let other = ["xapp", "1", "AOTHER01", "3333333333333", String(repeating: "b", count: 64)].joined(separator: "-")
    XCTAssertTrue(slackTokenMatches(.linkBot, bot, appID: nil))
    XCTAssertTrue(slackTokenMatches(.linkApp, other, appID: nil), "Any app's, since the link made a new one")
    XCTAssertFalse(slackTokenMatches(.linkApp, bot, appID: nil))
    XCTAssertFalse(slackTokenMatches(.linkApp, "\(other)\n", appID: nil))
    XCTAssertEqual(slackLinkAppID(other), "AOTHER01")
    XCTAssertNil(slackLinkAppID("xapp-1-nope"))
    let duplicate = slackLinkWarning(.init(state: "created", appID: "AJOJO01", manifestOutdated: false), dot: "jojo")
    XCTAssertTrue(duplicate.contains("duplicate"))
    XCTAssertTrue(duplicate.contains("AJOJO01 stays in Slack"))
    XCTAssertTrue(slackLinkWarning(.init(state: "unknown", manifestOutdated: false), dot: "jojo").contains("may already exist"))
  }

  @MainActor func testALoginsCommandIsHeldInMemoryAndItsCodeIsSentOnce() async throws {
    let store = try isolatedStore()
    let ticket = SlackLoginTicket(attempt: "a1", command: "/slackauthticket TICKET", expiresAt: 9e15)
    var sent: [SlackAction] = []
    let daemon = Sent()
    store.slackRead = { _ in SlackSetup(config: .init(state: "idle"), login: .init(state: "none")) }
    store.slackSend = { _, action in
      sent.append(action)
      if let failure = daemon.failure { throw failure }
      if case .loginStart = action { return .ticket(ticket) }
      return .said("Logged in to Slack.")
    }
    store.startLogin("jojo")
    await eventually { !store.slackBusy.contains("jojo") && store.slackTicket != nil }
    XCTAssertEqual(store.slackTicket, ticket)
    var copied: [String] = []
    store.copyText = { copied.append($0) }
    store.copyText(ticket.command)
    XCTAssertEqual(copied, ["/slackauthticket TICKET"])

    // A lost answer still uses the login up: it's never sent again.
    daemon.failure = APIError.lost
    store.finishLogin("jojo", challenge: "CODE1")
    XCTAssertNil(store.slackTicket)
    await eventually { !store.slackBusy.contains("jojo") }
    store.finishLogin("jojo", challenge: "CODE1")
    XCTAssertEqual(sent, [.loginStart, .loginFinish(attempt: "a1", challenge: "CODE1")])

    daemon.failure = nil
    store.startLogin("jojo")
    await eventually { !store.slackBusy.contains("jojo") && store.slackTicket != nil }
    store.finishLogin("jojo", challenge: "CODE2")
    await eventually { !store.slackBusy.contains("jojo") && store.slackNotices["jojo"]?.hasPrefix("Logged in") == true }
    XCTAssertEqual(sent.last, .loginFinish(attempt: "a1", challenge: "CODE2"))
    XCTAssertFalse(store.slackNotices.values.contains { $0.contains("CODE") || $0.contains("TICKET") })

    store.runSlack("jojo", .install)
    await eventually { !store.slackBusy.contains("jojo") }
    XCTAssertEqual(sent.last, .install)
  }

  /// A store showing jojo's Slack view of a created app, with a fake clipboard and a fake daemon
  /// that records each action. A bot pickup is armed.
  @MainActor private func armedStore() throws -> (Store, FakeClipboard, Sent) {
    let store = try isolatedStore()
    let clipboard = FakeClipboard()
    let sent = Sent()
    store.clipboard = clipboard
    store.uptime = { sent.now }
    store.openSlackPage = { _ in XCTFail("No page opens in this test") }
    store.slackRead = { _ in sent.view }
    store.slackSend = { _, action in
      sent.actions.append(action)
      if let failure = sent.failure { throw failure }
      return .view(sent.view)
    }
    store.showingSlack = true
    store.slackStates["jojo"] = created("AJOJO01")
    store.armPickup("jojo", .bot)
    XCTAssertEqual(store.slackPickup?.step, .bot)
    return (store, clipboard, sent)
  }
}

@MainActor private final class Sent {
  var actions: [SlackAction] = []
  var failure: Error?
  /// The owner's answer to a replacement, and a view a refresh shows while it's being asked.
  var confirm = false
  var duringConfirm: SlackSetup?
  var view = created("AJOJO01")
  var now: TimeInterval = 1_000
}

private func created(_ appID: String) -> SlackSetup {
  SlackSetup(config: .init(state: "idle", saved: true), app: .init(state: "created", appID: appID, manifestOutdated: false))
}

/// The clipboard in memory: each copy is a new revision, and a clear empties only the revision given.
@MainActor private final class FakeClipboard: Clipboard {
  var revision = 0
  var contents: String?
  var reads = 0
  var cleared: [Int] = []
  var afterRead: @MainActor () -> Void = {}

  func copy(_ text: String) {
    revision += 1
    contents = text
  }

  func text() -> String? {
    reads += 1
    defer { afterRead() }
    return contents
  }

  func clear(revision: Int) {
    guard revision == self.revision else { return }
    contents = nil
    cleared.append(revision)
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
