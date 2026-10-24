import XCTest
@testable import open_dot_notch

final class ResponsibilityRunTests: XCTestCase {
  private func run(_ id: Int, _ state: String, _ fields: String = "", delivery: String = "admitted", workers: String = "[]") throws -> ResponsibilityRun {
    let json = """
      {"id":\(id),"responsibility":3,"dueAt":1792742400000,"claimedAt":1792742460000,
       "snapshot":{"goal":"Inbox zero","nextAction":"Triage","schedule":{"kind":"interval","everyMinutes":10},"version":4},
       "sessionID":"ses_jojo","messageID":"msg_\(id)","state":"\(state)","delivery":"\(delivery)",
       "observedAt":null,"waiting":false,"workers":\(workers)\(fields)}
      """
    return try JSONDecoder().decode(ResponsibilityRun.self, from: Data(json.utf8))
  }

  func testAFinishedTurnNeverSaysTheGoalWasMet() throws {
    let finished = try run(1, "finished-turn", #","turn":{"outcome":"succeeded","error":null,"end":"idle_1","endedAt":1792742500000},"attribution":"exclusive","result":{"messageID":"msg_r","text":"Nothing new."}"#)
    XCTAssertEqual(finished.stateTitle, "turn finished, goal not checked")
    XCTAssertFalse(finished.unresolved)
    XCTAssertEqual(finished.result?.text, "Nothing new.")
    XCTAssertNil(finished.attributionNote)
    XCTAssertEqual(finished.snapshot.goal, "Inbox zero")
  }

  func testUnresolvedStatesStayVisiblyUnresolved() throws {
    let cases = [
      ("queued", "queued"),
      ("admitted", "admitted, not started"),
      ("running", "running"),
      ("needs-you", "needs you"),
      ("unknown", "outcome unknown"),
    ]
    for (state, title) in cases {
      let item = try run(2, state)
      XCTAssertEqual(item.stateTitle, title)
      XCTAssertTrue(item.unresolved, state)
    }
    let sending = try run(3, "queued", delivery: "sending")
    XCTAssertEqual(sending.stateTitle, "sending, not confirmed")
  }

  func testAFailedOrSharedTurnSaysWhyItHasNoResult() throws {
    let interrupted = try run(4, "failed", #","turn":{"outcome":"interrupted"},"attribution":"shared""#)
    XCTAssertEqual(interrupted.stateTitle, "interrupted")
    XCTAssertNil(interrupted.result)
    XCTAssertEqual(interrupted.attributionNote, "Its turn also handled other messages, so no reply is attributed to this run.")
    let failed = try run(5, "failed", #","turn":{"outcome":"failed","error":"provider down"},"attribution":"unknown""#)
    XCTAssertEqual(failed.stateTitle, "failed")
    XCTAssertEqual(failed.turn?.error, "provider down")
    XCTAssertNotNil(failed.attributionNote)
  }

  func testDelegatedWorkersSayWhatTheyNeedAndHowTheyEnded() throws {
    let item = try run(6, "needs-you", workers: #"[{"id":7,"state":"running","outcome":null,"task":"Sort","sessionID":"ses_w","directory":"/w","createdAt":1,"finishedAt":null,"needs":["permission"]},{"id":8,"state":"done","outcome":"failed","task":"Tag","sessionID":"ses_x","directory":"/x","createdAt":1,"finishedAt":2,"needs":[]}]"#)
    XCTAssertEqual(item.workers.map(\.line), ["Worker #7: Sort · needs you: permission", "Worker #8: Tag · finished (failed)"])
  }

  func testRunPagesKeepOlderRowsAndAStaleReadCantOverwriteANewerOne() throws {
    var list = RunListState()
    let stale = list.startRead()
    let fresh = list.startRead()
    list.apply(fresh, RunPage(runs: [try run(3, "finished-turn"), try run(2, "running")], next: 2), older: false)
    list.apply(stale, RunPage(runs: [try run(3, "running")], next: nil), older: false)
    XCTAssertEqual(list.rows.map(\.state), ["finished-turn", "running"])
    XCTAssertEqual(list.older, 2)
    let older = list.startRead()
    list.apply(older, RunPage(runs: [try run(1, "unknown")], next: nil), older: true)
    XCTAssertEqual(list.rows.map(\.id), [3, 2, 1])
    XCTAssertNil(list.older)
  }

  func testAReadFromBeforeAHideChangesNothingAfterTheListOpensAgain() throws {
    var first = RunListState()
    let stale = first.startRead()
    let staleOlder = first.startRead()
    // Hidden, then shown again: a new opening.
    var reopened = RunListState()
    let fresh = reopened.startRead()
    reopened.loadingOlder = true
    reopened.apply(stale, RunPage(runs: [try run(1, "running")], next: 999), older: false)
    reopened.fail(staleOlder, "old failure", older: true)
    XCTAssertTrue(reopened.rows.isEmpty)
    XCTAssertNil(reopened.older)
    XCTAssertNil(reopened.error)
    XCTAssertTrue(reopened.loadingOlder)
    reopened.apply(fresh, RunPage(runs: [try run(1, "finished-turn")], next: 1), older: false)
    XCTAssertEqual(reopened.rows.map(\.state), ["finished-turn"])
    XCTAssertEqual(reopened.older, 1)
    // A fresh read answered first is kept when the old opening's answers arrive after it.
    reopened.apply(stale, RunPage(runs: [try run(1, "running")], next: 999), older: false)
    XCTAssertEqual(reopened.rows.map(\.state), ["finished-turn"])
    XCTAssertEqual(reopened.older, 1)
  }

  func testAStaleAnswerCantMoveTheCursorOrTheError() throws {
    var list = RunListState()
    let old = list.startRead()
    let new = list.startRead()
    list.apply(new, RunPage(runs: [try run(3, "finished-turn"), try run(2, "running")], next: 2), older: false)
    list.apply(old, RunPage(runs: [try run(3, "running"), try run(2, "running")], next: 999), older: false)
    XCTAssertEqual(list.older, 2)
    XCTAssertEqual(list.rows.map(\.state), ["finished-turn", "running"])
    list.fail(old, "late failure", older: false)
    XCTAssertNil(list.error)
    // A newer failure shows, and a later success clears it.
    let failing = list.startRead()
    list.fail(failing, "Runs not refreshed.", older: false)
    XCTAssertEqual(list.error, "Runs not refreshed.")
    let recovered = list.startRead()
    list.apply(recovered, RunPage(runs: [try run(3, "finished-turn")], next: 2), older: false)
    XCTAssertNil(list.error)
    XCTAssertEqual(list.older, 2)
  }

  func testAnOlderPageEndsItsLoadingAndMovesTheCursorOnlyForItsOwnOpening() throws {
    var list = RunListState()
    list.apply(list.startRead(), RunPage(runs: [try run(3, "finished-turn")], next: 3), older: false)
    list.loadingOlder = true
    let older = list.startRead()
    let refresh = list.startRead()
    // The newer refresh of the newest page answers first, then the older page.
    list.apply(refresh, RunPage(runs: [try run(3, "finished-turn")], next: 3), older: false)
    XCTAssertTrue(list.loadingOlder)
    list.apply(older, RunPage(runs: [try run(2, "failed"), try run(1, "unknown")], next: nil), older: true)
    XCTAssertFalse(list.loadingOlder)
    XCTAssertEqual(list.rows.map(\.id), [3, 2, 1])
    XCTAssertNil(list.older)
  }

  func testProvisionalAndWithheldWorkersDecode() throws {
    let running = try run(7, "running", workers: #"[{"id":7,"state":"running","task":"Sort","sessionID":"ses_w","needs":[],"provisional":true}]"#)
    XCTAssertEqual(running.workers.first?.provisional, true)
    XCTAssertNil(running.withheldWorkers)
    let shared = try run(8, "finished-turn", #","attribution":"shared","withheldWorkers":2"#)
    XCTAssertTrue(shared.workers.isEmpty)
    XCTAssertEqual(shared.withheldWorkers, 2)
  }

  func testEvidenceAnswersApplyOnlyToTheOpeningThatAskedForThem() throws {
    var evidence = RunEvidenceState()
    let key = RunEvidenceKey(dot: "jojo", run: 1, message: "msg_1")
    let first = try XCTUnwrap(evidence.toggle(key))
    XCTAssertEqual(evidence.shown[key], .loading)
    XCTAssertNil(evidence.toggle(key))
    XCTAssertNil(evidence.shown[key])
    // A closed opening's answer doesn't open it again.
    evidence.finish(key, first, .read(.gone))
    XCTAssertNil(evidence.shown[key])
    let second = try XCTUnwrap(evidence.toggle(key))
    evidence.finish(key, first, .failed("stale"))
    XCTAssertEqual(evidence.shown[key], .loading)
    evidence.finish(key, second, .read(.elsewhere))
    XCTAssertEqual(evidence.shown[key], .read(.elsewhere))
    // Another run's evidence is separate.
    let other = RunEvidenceKey(dot: "jojo", run: 2, message: "msg_1")
    XCTAssertNil(evidence.shown[other])
  }
}
