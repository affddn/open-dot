import XCTest
@testable import open_dot_notch

final class MemoryStateTests: XCTestCase {
  private func note(_ id: Int, _ text: String, version: Int = 1, by actor: String = "dot") -> MemoryNote {
    MemoryNote(id: id, version: version, updatedAt: 0, updatedBy: actor, text: text)
  }

  private func reminder(_ id: Int, state: String = "scheduled", version: Int = 1) -> MemoryReminder {
    MemoryReminder(id: id, version: version, updatedAt: 0, updatedBy: "dot", text: "Stretch", dueAt: 4_000_000_000_000, everyMinutes: nil, state: state)
  }

  private func loaded(_ notes: [MemoryNote], reminders: [MemoryReminder] = []) -> MemoryState {
    var state = MemoryState()
    XCTAssertTrue(state.apply(state.startRead(), Memory(notes: notes, responsibilities: [], reminders: reminders)))
    return state
  }

  func testAReadBegunBeforeOrDuringAChangeCantOverwriteItsResult() {
    var state = loaded([note(1, "old")])
    let before = state.startRead()
    let key = MemoryKey(kind: .note, id: 1)
    XCTAssertTrue(state.begin(key))
    XCTAssertFalse(state.begin(key), "A second click while saving sends nothing")
    let during = state.startRead()
    state.finish(key, .outcome(.saved(.note(note(1, "new", version: 2, by: "owner")))))
    XCTAssertFalse(state.apply(before, Memory(notes: [note(1, "old")], responsibilities: [], reminders: [])))
    XCTAssertFalse(state.apply(during, Memory(notes: [note(1, "old")], responsibilities: [], reminders: [])))
    XCTAssertEqual(state.memory?.notes, [note(1, "new", version: 2, by: "owner")])
    // A read begun after the change settled is shown, including the dot's later edits.
    XCTAssertTrue(state.apply(state.startRead(), Memory(notes: [note(1, "dot's", version: 3)], responsibilities: [], reminders: [])))
    XCTAssertEqual(state.memory?.notes.first?.text, "dot's")
  }

  func testAConflictShowsCurrentValueAndKeepsRejectedTextWithoutRetrying() {
    var state = loaded([note(1, "old")])
    let key = MemoryKey(kind: .note, id: 1)
    state.edit(.note(note(1, "old")))
    state.drafts[key]?.text = "mine"
    XCTAssertTrue(state.begin(key))
    state.finish(key, .outcome(.conflict(.note(note(1, "dot's", version: 2)), "changed")))
    XCTAssertEqual(state.memory?.notes, [note(1, "dot's", version: 2)])
    XCTAssertNil(state.drafts[key])
    XCTAssertEqual(state.rejected[key]?.text, "mine")
    XCTAssertEqual(state.rejected[key]?.version, 1)
    XCTAssertNotNil(state.errors[key])
    XCTAssertTrue(state.saving.isEmpty)
  }

  func testAnUnknownOutcomeKeepsTheItemAndDraftForAManualRetryAtTheSameVersion() {
    var state = loaded([note(1, "old")])
    let key = MemoryKey(kind: .note, id: 1)
    state.edit(.note(note(1, "old")))
    state.drafts[key]?.text = "mine"
    XCTAssertTrue(state.begin(key))
    state.finish(key, .failed("Outcome unknown"))
    XCTAssertEqual(state.memory?.notes, [note(1, "old")])
    XCTAssertEqual(state.drafts[key]?.text, "mine")
    XCTAssertEqual(state.drafts[key]?.version, 1)
    XCTAssertEqual(state.errors[key], "Outcome unknown")
  }

  func testGoneDeletedAndAlreadySentItemsLeaveWithANotice() {
    var state = loaded([note(1, "a"), note(2, "b")], reminders: [reminder(3), reminder(4)])
    let outcomes: [(MemoryKey, MemoryOutcome)] = [
      (MemoryKey(kind: .note, id: 1), .deleted),
      (MemoryKey(kind: .note, id: 2), .gone("missing")),
      (MemoryKey(kind: .reminder, id: 3), .conflict(.reminder(reminder(3, state: "sent", version: 2)), "sent")),
    ]
    for (key, outcome) in outcomes {
      XCTAssertTrue(state.begin(key))
      state.finish(key, .outcome(outcome))
    }
    XCTAssertEqual(state.memory?.notes, [])
    XCTAssertEqual(state.memory?.reminders.map(\.id), [4])
    XCTAssertNotNil(state.notice)
  }

  func testOnlyChangedFieldsAreSentAndInvalidValuesNeverAre() throws {
    let base = MemoryResponsibility(id: 1, version: 4, updatedAt: 0, updatedBy: "dot", goal: "Ship", nextAction: "Write", status: "active")
    var draft = MemoryDraft(.responsibility(base))
    XCTAssertNil(try draft.changes())
    draft.nextAction = "  Review  "
    let fields = try XCTUnwrap(try draft.changes())
    XCTAssertEqual(fields as NSDictionary, ["nextAction": "Review"] as NSDictionary)
    XCTAssertEqual(draft.version, 4)
    draft.goal = " "
    XCTAssertThrowsError(try draft.changes())

    var later = MemoryDraft(.reminder(reminder(3)))
    later.repeats = true
    later.every = 0
    XCTAssertThrowsError(try later.changes())
    later.every = 1440
    XCTAssertEqual(try later.changes() as NSDictionary?, ["everyMinutes": 1440] as NSDictionary)
    later.repeats = false
    later.due = Date(timeIntervalSince1970: 1)
    XCTAssertThrowsError(try later.changes(), "A past time is refused before sending")
  }

  func testChangesNameWhoMadeThem() {
    let now = Date(timeIntervalSince1970: 3600)
    XCTAssertEqual(memoryChange(3_000_000, by: "owner", dot: "jojo", now: now), "Updated 10m ago by you")
    XCTAssertEqual(memoryChange(3_600_000, by: "dot", dot: "jojo", now: now), "Updated just now by jojo")
    XCTAssertEqual(memoryChange(0, by: "scheduler", dot: "jojo", now: now), "Updated 1h ago by its schedule")
  }
}
