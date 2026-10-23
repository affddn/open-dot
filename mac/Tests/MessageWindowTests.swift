import XCTest
@testable import open_dot_notch

final class MessageWindowTests: XCTestCase {
  @MainActor func testInFlightMutationBlocksBothMessageActions() async {
    let store = Store()
    let key = MessageKey(dot: "jojo", message: "msg_0")
    var window = MessageWindow()
    window.mergeLatest(page(0..<1))
    store.conversations[key.dot] = window
    store.hiding.insert(key)
    XCTAssertTrue(store.messageMutationPending(key))
    store.react(key, emoji: "👍")
    XCTAssertFalse(store.reacting.contains(key))
    store.hiding.remove(key)
    store.reacting.insert(key)
    store.hide(key, session: "ses_one")
    XCTAssertFalse(store.hiding.contains(key))
    store.reacting.remove(key)
    XCTAssertFalse(store.messageMutationPending(key))
  }

  private func page(_ range: Range<Int>, next: String? = "older", session: String = "ses_one") -> MessagePage {
    MessagePage(messages: range.map {
      Message(id: "msg_\($0)", sessionID: session, kind: "dot", peer: nil, text: "Message \($0)", tools: [], attachments: [], feed: nil, time: Double($0), reactions: [])
    }, sessionID: session, next: next, pending: [], recentEmojis: [])
  }

  func testLatestPollMergesUpdatesAndDoesNotInvalidateAnUnchangedWindow() {
    var window = MessageWindow()
    window.mergeLatest(page(40..<60))
    window.prepend(page(20..<40, next: "oldest"))
    let before = window
    window.mergeLatest(page(40..<60))
    XCTAssertEqual(window, before)
    window.mergeLatest(page(42..<62))
    XCTAssertEqual(window.items.map(\.id), (20..<62).map { "msg_\($0)" })
    XCTAssertEqual(window.next, "oldest")
  }

  func testOlderPagesDeduplicateAndRetainProjectionOrderNotTimestampOrder() {
    var window = MessageWindow()
    window.mergeLatest(page(40..<60))
    window.prepend(page(20..<45, next: nil))
    XCTAssertEqual(window.items.map(\.id), (20..<60).map { "msg_\($0)" })
    XCTAssertNil(window.next)
  }

  func testHistoryWalkStaysBoundedAndLatestReturnsWithoutARead() {
    var window = MessageWindow()
    window.mergeLatest(page(480..<500))
    window.atBottom = false
    for start in stride(from: 460, through: 0, by: -20) {
      window.prepend(page(start..<(start + 20), next: start == 0 ? nil : "before\(start)"))
      XCTAssertLessThanOrEqual(window.retainedIDs.count, 100)
      XCTAssertEqual(window.items.first?.id, "msg_\(start)")
    }
    window.mergeLatest(page(482..<502))
    XCTAssertEqual(window.items.first?.id, "msg_0", "Polling cannot evict the reading anchor")
    XCTAssertTrue(window.hasNewer)
    XCTAssertLessThanOrEqual(window.retainedIDs.count, 100)
    window.showLatest()
    XCTAssertEqual(window.items.last?.id, "msg_501")
    XCTAssertTrue(window.atBottom)
    XCTAssertFalse(window.hasNewer)
    XCTAssertNotNil(window.next)
  }

  func testBottomTrimsOldestAndCanPageBackWithoutSkippingDroppedMessages() {
    var window = MessageWindow()
    window.mergeLatest(page(80..<100, next: "before80"))
    window.prepend(page(0..<80, next: nil))
    window.mergeLatest(page(90..<110, next: "before90"))
    XCTAssertLessThanOrEqual(window.retainedIDs.count, 100)
    XCTAssertEqual(window.items.first?.id, "msg_10")
    XCTAssertEqual(window.items.last?.id, "msg_109")
    XCTAssertEqual(window.next, "before90")
    window.atBottom = false
    for end in stride(from: 90, through: 10, by: -20) {
      window.prepend(page(max(0, end - 20)..<end, next: end <= 20 ? nil : "before\(end - 20)"))
    }
    XCTAssertEqual(window.items.first?.id, "msg_0")
    XCTAssertNil(window.next)
    XCTAssertEqual(window.items.map(\.id), (0..<80).map { "msg_\($0)" })
  }

  func testRenderedOlderBottomCannotJumpAcrossEvictedHistory() {
    var window = MessageWindow()
    let latest = page(480..<500)
    window.mergeLatest(latest)
    window.atBottom = false
    for start in stride(from: 460, through: 300, by: -20) {
      window.prepend(page(start..<(start + 20)))
    }
    let older = window.items
    XCTAssertTrue(window.hasNewer)
    window.atBottom = true
    window.mergeLatest(latest)
    XCTAssertFalse(window.atBottom)
    XCTAssertEqual(window.items, older)
  }

  func testRefreshedOlderOverlapReconcilesHiddenState() {
    var window = MessageWindow()
    window.mergeLatest(page(80..<100))
    window.prepend(page(60..<80))
    var saved = page(60..<80)
    saved.messages[0].hidden = true
    window.prepend(saved)
    XCTAssertEqual(window.items.first?.hidden, true)
    XCTAssertEqual(window.items.count, 40)
  }

  func testExactReconciliationUpdatesOlderMutationWithoutReinsertingEvictedOrOtherSessionMessages() {
    var window = MessageWindow()
    window.mergeLatest(page(80..<100))
    window.prepend(page(60..<80))
    var saved = page(60..<61).messages[0]
    saved.hidden = true
    saved.reactions = [Reaction(dot: "jojo", sessionID: "ses_one", messageID: saved.id, actor: "owner", emoji: "👍", updatedAt: 1)]
    window.reconcile(saved)
    XCTAssertEqual(window.items.first, saved)
    window.reconcile(page(60..<61, session: "ses_other").messages[0])
    XCTAssertEqual(window.items.first, saved)
    window.showLatest()
    window.reconcile(saved)
    XCTAssertEqual(window.items.count, 20)
    XCTAssertFalse(window.retainedIDs.contains(saved.id))
  }

  func testSessionReplacementClearsOldHistoryEvenForAnEmptyPage() {
    var window = MessageWindow()
    window.mergeLatest(page(0..<20))
    window.mergeLatest(page(0..<0, next: nil, session: "ses_two"))
    XCTAssertEqual(window.sessionID, "ses_two")
    XCTAssertTrue(window.items.isEmpty)
    window.prepend(page(20..<40, session: "ses_one"))
    XCTAssertTrue(window.items.isEmpty, "An old history request cannot cross the binding")
  }

  func testPendingIDsMatchHiddenMessagesAndOlderPages() {
    var window = MessageWindow()
    var older = page(0..<20)
    older.messages[0].hidden = true
    window.mergeLatest(page(20..<40))
    window.prepend(older)
    XCTAssertTrue(window.delivered("msg_0", sentAt: 0, statuses: [:]))
    XCTAssertFalse(window.delivered("msg_pending", sentAt: 0, statuses: ["msg_pending": "sent"]))
    XCTAssertTrue(window.delivered("msg_evicted", sentAt: -1, statuses: [:]))
  }

  func testReactionRecheckWaitsForIntendedStateInTheSameSession() {
    let recheck = MessageRecheck(session: "ses_one", desired: .reaction("👍"), order: 1)
    var message = page(0..<1).messages[0]
    XCTAssertFalse(recheck.matches(message))
    message.reactions = [Reaction(dot: "jojo", sessionID: "ses_one", messageID: message.id, actor: "dot", emoji: "👍", updatedAt: 1)]
    XCTAssertFalse(recheck.matches(message))
    message.reactions = [Reaction(dot: "jojo", sessionID: "ses_one", messageID: message.id, actor: "owner", emoji: "👍", updatedAt: 1)]
    XCTAssertTrue(recheck.matches(message))
    var rebound = page(0..<1, session: "ses_other").messages[0]
    rebound.reactions = message.reactions
    XCTAssertFalse(recheck.matches(rebound))
    let removal = MessageRecheck(session: "ses_one", desired: .reaction(nil), order: 2)
    XCTAssertFalse(removal.matches(message))
    message.reactions = []
    XCTAssertTrue(removal.matches(message))
  }

  func testHiddenRecheckWaitsForSavedMarkerInTheSameSession() {
    let recheck = MessageRecheck(session: "ses_one", desired: .hidden, order: 1)
    var message = page(0..<1).messages[0]
    XCTAssertFalse(recheck.matches(message))
    message.hidden = true
    XCTAssertTrue(recheck.matches(message))
    var rebound = page(0..<1, session: "ses_other").messages[0]
    rebound.hidden = true
    XCTAssertFalse(recheck.matches(rebound))
  }
}
