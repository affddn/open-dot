import XCTest
@testable import open_dot_notch

/// Drives the Store's own latest-page refresh with injected daemon reads. Issue #44 measured reads
/// of 4.3 s at p50 and 7.4 s at p95, so the latency tests sleep real seconds.
private let dot = "issue-44-test"

final class MessageRefreshTests: XCTestCase {
  @MainActor func testOverlappingTriggersShareOneReadAndEveryAnswerApplies() async throws {
    let store = Store()
    let reads = Reads()
    let latency: [Duration] = [.seconds(4), .seconds(1)]
    store.latestPage = { _ in
      let call = reads.begin()
      defer { reads.end() }
      try await Task.sleep(for: latency[min(call, latency.count) - 1])
      return page(messages("msg_\(call)"))
    }
    // Select, the visible poll and a finished turn, a second apart, while the first read runs.
    var triggers: [Task<Void, Never>] = []
    for _ in 0..<3 {
      triggers.append(Task { await store.refreshMessages(dot) })
      try await Task.sleep(for: .seconds(1))
    }
    XCTAssertEqual(reads.calls, 1)
    XCTAssertNil(store.conversations[dot], "Still loading")
    XCTAssertNil(store.messageErrors[dot])
    await eventually(within: .seconds(3)) { store.conversations[dot]?.items.map(\.id) == ["msg_1"] }
    await eventually(within: .seconds(3)) { store.conversations[dot]?.items.map(\.id) == ["msg_2"] }
    for trigger in triggers { await trigger.value }
    XCTAssertEqual(reads.calls, 2, "Triggers during a read share one follow-up read")
    XCTAssertEqual(reads.most, 1, "One read per dot at a time")
  }

  @MainActor func testAnEightSecondReadDoesNotHoldBackAnotherDot() async {
    let store = Store()
    store.latestPage = { name in
      try await Task.sleep(for: name == "slow" ? .seconds(8) : .seconds(1))
      return page(messages("\(name)_1"))
    }
    let slow = Task { await store.refreshMessages("slow") }
    let fast = Task { await store.refreshMessages("fast") }
    await fast.value
    XCTAssertEqual(store.conversations["fast"]?.items.map(\.id), ["fast_1"])
    XCTAssertNil(store.conversations["slow"], "Still loading")
    XCTAssertNil(store.messageErrors["slow"])
    await slow.value
    XCTAssertEqual(store.conversations["slow"]?.items.map(\.id), ["slow_1"])
  }

  @MainActor func testPollOverlappingAReactionIsDiscardedAndTheRecheckKeepsItsResult() async throws {
    let store = Store()
    store.saveReaction = { _, _ in throw APIError.lost }
    let key = MessageKey(dot: dot, message: "msg_0")
    store.latestPage = { _ in page(messages("msg_0")) }
    await store.refreshMessages(dot)
    let gate = Gate()
    let reads = Reads()
    // Read before the reaction landed.
    store.latestPage = { _ in
      _ = reads.begin()
      await gate.wait()
      return page(messages("msg_0", "msg_1"))
    }
    store.oneMessage = { key, session in message(key.message, session: session, emoji: "👍") }
    let poll = Task { await store.refreshMessages(dot) }
    await eventually { reads.calls == 1 }
    store.react(key, emoji: "👍")
    XCTAssertTrue(store.messageMutationPending(key))
    // The reaction's answer is lost, so the recheck reads the saved state.
    await eventually { !store.messageMutationPending(key) }
    XCTAssertEqual(ownerEmoji(store, key), "👍")
    gate.release()
    await poll.value
    XCTAssertEqual(ownerEmoji(store, key), "👍", "A poll begun before the reaction can't undo it")
    XCTAssertEqual(store.conversations[dot]?.items.map(\.id), ["msg_0"], "The overlapping poll is discarded")
    store.latestPage = { _ in page([message("msg_0", emoji: "👍"), message("msg_1")]) }
    await store.refreshMessages(dot)
    XCTAssertEqual(store.conversations[dot]?.items.map(\.id), ["msg_0", "msg_1"], "The next poll applies")
    XCTAssertEqual(ownerEmoji(store, key), "👍")
  }

  @MainActor func testLoadErrorsAreShownAndRetryLoads() async {
    let store = Store()
    XCTAssertNil(store.conversations[dot])
    XCTAssertNil(store.messageErrors[dot])
    store.latestPage = { _ in throw APIError.lost }
    await store.refreshMessages(dot)
    XCTAssertNil(store.conversations[dot])
    XCTAssertEqual(store.messageErrors[dot], "The open-dot daemon didn't answer in time.")

    store.latestPage = { _ in throw APIError.server("Service Unavailable") }
    await retry(store)
    XCTAssertEqual(store.messageErrors[dot], "Service Unavailable")

    store.latestPage = { _ in try API.decode(MessagePage.self, Data(#"{"messages":[{"id":1}]}"#.utf8), log: { _ in }) }
    await retry(store)
    XCTAssertEqual(store.messageErrors[dot], "Unexpected response from the open-dot daemon")
    XCTAssertNil(store.conversations[dot])

    store.latestPage = { _ in page(messages("msg_0")) }
    await retry(store)
    XCTAssertNil(store.messageErrors[dot])
    XCTAssertEqual(store.conversations[dot]?.items.map(\.id), ["msg_0"])

    store.latestPage = { _ in throw APIError.lost }
    await store.refreshMessages(dot)
    XCTAssertEqual(store.conversations[dot]?.items.map(\.id), ["msg_0"], "A failed refresh keeps what's shown")
    XCTAssertNotNil(store.messageErrors[dot])

    store.latestPage = { _ in page(messages("msg_0", "msg_1"), refreshError: "Couldn't refresh messages from OpenCode. Retry.") }
    await store.refreshMessages(dot)
    XCTAssertEqual(store.conversations[dot]?.items.map(\.id), ["msg_0", "msg_1"], "A stale page still applies")
    XCTAssertEqual(store.messageErrors[dot], "Couldn't refresh messages from OpenCode. Retry.")

    store.latestPage = { _ in page(messages("msg_0", "msg_1")) }
    await store.refreshMessages(dot)
    XCTAssertNil(store.messageErrors[dot])
  }

  func testLiveRedactedPagesDecode() throws {
    for name in ["issue-44-jotaro-latest", "issue-44-jolyne-latest"] {
      var lines: [String] = []
      let page = try API.decode(MessagePage.self, fixture(name), log: { lines.append($0) })
      XCTAssertEqual(lines, [])
      XCTAssertEqual(page.messages.count, 20)
      XCTAssertNotNil(page.sessionID)
      XCTAssertNotNil(page.next)
      XCTAssertEqual(page.statuses, [:])
      XCTAssertNil(page.refreshError)
      XCTAssertTrue(Set(page.messages.map(\.kind)).isSubset(of: ["dot", "owner", "peer"]))
    }
    let jotaro = try API.decode(MessagePage.self, fixture("issue-44-jotaro-latest"), log: { _ in })
    XCTAssertEqual(jotaro.messages.flatMap { $0.attachments ?? [] }.filter(\.isImage).count, 1)
    let jolyne = try API.decode(MessagePage.self, fixture("issue-44-jolyne-latest"), log: { _ in })
    XCTAssertEqual(jolyne.messages.compactMap(\.feed).map(\.id), [0])
  }

  func testDecodeFailureLogsOnlyTheFieldPath() throws {
    var json = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture("issue-44-jotaro-latest")) as? [String: Any])
    var list = try XCTUnwrap(json["messages"] as? [[String: Any]])
    list[1]["text"] = "SECRET message text"
    list[2]["time"] = "SECRET time"
    json["messages"] = list
    let data = try JSONSerialization.data(withJSONObject: json)
    var lines: [String] = []
    XCTAssertThrowsError(try API.decode(MessagePage.self, data, log: { lines.append($0) })) { error in
      XCTAssertEqual((error as? APIError)?.message, "Unexpected response from the open-dot daemon")
    }
    XCTAssertEqual(lines, ["open-dot-notch: couldn't decode MessagePage at messages[2].time (typeMismatch)"])
    lines = []
    XCTAssertThrowsError(try API.decode(MessagePage.self, Data("SECRET".utf8), log: { lines.append($0) }))
    XCTAssertEqual(lines, ["open-dot-notch: couldn't decode MessagePage at <root> (dataCorrupted)"])
    XCTAssertFalse(lines.joined().contains("SECRET"))
  }

  @MainActor private func retry(_ store: Store) async {
    store.retryMessages(dot)
    XCTAssertTrue(store.retrying.contains(dot))
    await eventually { !store.retrying.contains(dot) }
  }

  private func fixture(_ name: String) throws -> Data {
    try Data(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "Fixtures/\(name).json"))
  }
}

@MainActor private final class Reads {
  private(set) var calls = 0
  private(set) var most = 0
  private var active = 0

  func begin() -> Int {
    calls += 1
    active += 1
    most = max(most, active)
    return calls
  }

  func end() { active -= 1 }
}

@MainActor private final class Gate {
  private var open = false
  private var waiters: [CheckedContinuation<Void, Never>] = []

  func wait() async {
    if open { return }
    await withCheckedContinuation { waiters.append($0) }
  }

  func release() {
    open = true
    for waiter in waiters { waiter.resume() }
    waiters = []
  }
}

@MainActor private func eventually(within limit: Duration = .seconds(3), _ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
  let end = ContinuousClock.now + limit
  while !condition() && ContinuousClock.now < end { try? await Task.sleep(for: .milliseconds(10)) }
  XCTAssertTrue(condition(), "Timed out", file: file, line: line)
}

@MainActor private func ownerEmoji(_ store: Store, _ key: MessageKey) -> String? {
  store.conversations[key.dot]?.items.first { $0.id == key.message }?.reactions?.first { $0.actor == "owner" }?.emoji
}

private func message(_ id: String, session: String = "ses_one", emoji: String? = nil) -> Message {
  let reactions = emoji.map { [Reaction(dot: dot, sessionID: session, messageID: id, actor: "owner", emoji: $0, updatedAt: 1)] } ?? []
  return Message(id: id, sessionID: session, kind: "dot", peer: nil, text: "Message", tools: [], attachments: [], feed: nil, time: 1, reactions: reactions)
}

private func messages(_ ids: String...) -> [Message] {
  ids.map { message($0) }
}

private func page(_ messages: [Message], refreshError: String? = nil) -> MessagePage {
  MessagePage(messages: messages, sessionID: "ses_one", next: nil, pending: [], recentEmojis: nil, refreshError: refreshError)
}
