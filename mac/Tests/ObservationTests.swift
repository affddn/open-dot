import XCTest
@testable import open_dot_notch

final class ObservationTests: XCTestCase {
  private func row(_ id: Int, _ text: String, version: Int = 1, by actor: String = "observer") -> MemoryObservation {
    MemoryObservation(
      id: id, version: version, kind: "decision", topic: "Lisbon", text: text, priority: 1,
      sessionID: "ses_jojo", updatedAt: 0, updatedBy: actor,
      sources: [ObservationSource(messageID: "msg_1", sessionID: "ses_jojo", from: "owner", date: "2026-10-24T00:00:00.000Z", excerpt: "Budget is 40k.")])
  }

  func testTheMemoryReadDecodesTheLedgerAndOlderDaemonsSendNone() throws {
    let json = """
    {"notes":[],"responsibilities":[],"reminders":[],"observationsSuperseded":2,
     "observations":[{"id":3,"version":1,"kind":"fact","topic":"travel","text":"Lisbon in May.","priority":2,
       "validFrom":1,"sessionID":"ses_jojo","createdAt":1,"updatedAt":5,"updatedBy":"observer",
       "sources":[{"messageID":"msg_a","sessionID":"ses_jojo","from":"owner","date":"x","excerpt":"Lisbon"},
                  {"messageID":"msg_gone","sessionID":"ses_jojo","missing":true}]}]}
    """
    let memory = try JSONDecoder().decode(Memory.self, from: Data(json.utf8))
    XCTAssertEqual(memory.observations?.first?.text, "Lisbon in May.")
    XCTAssertEqual(memory.observations?.first?.sources.last?.missing, true)
    XCTAssertEqual(memory.observationsSuperseded, 2)
    let old = try JSONDecoder().decode(Memory.self, from: Data(#"{"notes":[],"responsibilities":[],"reminders":[]}"#.utf8))
    XCTAssertNil(old.observations)
  }

  func testAnEditSendsOnlyChangedTextWithinTheLimit() throws {
    var draft = MemoryDraft(.observation(row(1, "Budget is 40k.")))
    XCTAssertNil(try draft.changes())
    draft.text = "Budget is 45k."
    XCTAssertEqual(try draft.changes()?["text"] as? String, "Budget is 45k.")
    XCTAssertEqual(draft.version, 1)
    draft.text = String(repeating: "x", count: observationTextLimit + 1)
    XCTAssertThrowsError(try draft.changes())
    draft.text = "  "
    XCTAssertThrowsError(try draft.changes())
  }

  func testASavedEditOrForgetUpdatesTheShownLedger() {
    var state = MemoryState()
    XCTAssertTrue(state.apply(state.startRead(), Memory(notes: [], responsibilities: [], reminders: [], observations: [row(1, "old"), row(2, "other")])))
    let key = MemoryKey(kind: .observation, id: 1)
    XCTAssertEqual(MemoryItem.observation(row(1, "old")).key, key)
    XCTAssertTrue(state.begin(key))
    state.finish(key, .outcome(.saved(.observation(row(1, "new", version: 2, by: "owner")))))
    XCTAssertEqual(state.memory?.observations?.map(\.text), ["new", "other"])
    XCTAssertTrue(state.begin(key))
    state.finish(key, .outcome(.deleted))
    XCTAssertEqual(state.memory?.observations?.map(\.id), [2])
  }
}

final class ObservationPagingTests: XCTestCase {
  private func row(_ id: Int) -> MemoryObservation {
    MemoryObservation(id: id, version: 1, kind: "fact", topic: "t", text: "Row \(id)", priority: 2, sessionID: "ses_jojo", updatedAt: 0, updatedBy: "observer", sources: [])
  }

  func testOlderPagesAppendOnlyWhileThePageShownStillContinues() {
    var state = MemoryState()
    XCTAssertTrue(state.apply(state.startRead(), Memory(notes: [], responsibilities: [], reminders: [], observations: [row(9), row(8)], observationsNext: 8)))
    XCTAssertTrue(state.appendObservations(ObservationPage(observations: [row(8), row(7)], next: 7), before: 8))
    XCTAssertEqual(state.memory?.observations?.map(\.id), [9, 8, 7])
    XCTAssertEqual(state.memory?.observationsNext, 7)
    // A late page for an older continuation is dropped.
    XCTAssertFalse(state.appendObservations(ObservationPage(observations: [row(1)], next: nil), before: 8))
    XCTAssertEqual(state.memory?.observations?.map(\.id), [9, 8, 7])
  }

  func testASourceReadDecodesFoundAndGone() throws {
    let found = try JSONDecoder().decode(ObservationSourceRead.self, from: Data(#"{"observation":1,"messageID":"msg_a","sessionID":"ses_j","state":"found","from":"owner","date":"x","text":"Hi","truncated":false}"#.utf8))
    XCTAssertEqual(found.text, "Hi")
    let gone = try JSONDecoder().decode(ObservationSourceRead.self, from: Data(#"{"observation":1,"messageID":"msg_a","sessionID":"ses_j","state":"gone"}"#.utf8))
    XCTAssertEqual(gone.state, "gone")
    XCTAssertNil(gone.text)
  }
}

final class DailyBudgetNoteTests: XCTestCase {
  func testTheNotchShowsTheDaemonsExactWords() {
    XCTAssertEqual(dailyBudgetNote, "Daily budget. One in-flight job can overshoot it, and then the observer stops until tomorrow.")
  }
}
