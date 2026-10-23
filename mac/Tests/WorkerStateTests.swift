import XCTest
@testable import open_dot_notch

final class WorkerStateTests: XCTestCase {
  private func dot(_ json: String) throws -> Dot {
    try JSONDecoder().decode(Dot.self, from: Data(json.utf8))
  }

  func testAWorkerWaitingOnYouSaysWhatForAndCountsOnItsDot() throws {
    let jojo = try dot(#"{"name":"jojo","purpose":null,"busy":true,"workers":[{"id":1,"state":"running","outcome":null,"task":"Fix","needs":["question"]},{"id":2,"state":"running","outcome":null,"task":"Ship","needs":["permission","question"]},{"id":3,"state":"running","outcome":null,"task":"Read","needs":[]}]}"#)
    XCTAssertEqual(jojo.workers.map(\.status), ["needs you: question", "needs you: permission, question", "running"])
    XCTAssertEqual(jojo.needsYouCount, 2)
  }

  func testStoppingAndOlderDaemonsShowPlainStates() throws {
    let older = try dot(#"{"name":"jojo","purpose":null,"busy":false,"workers":[{"id":1,"state":"waiting","task":"Fix"}]}"#)
    XCTAssertEqual(older.workers.first?.status, "waiting")
    XCTAssertEqual(older.needsYouCount, 0)
    let stopping = Dot.Worker(id: 4, state: "stopping", task: "Fix", needs: [])
    XCTAssertEqual(stopping.status, "stopping, not confirmed")
    XCTAssertFalse(stopping.needsYou)
    XCTAssertTrue(stopping.canStop)
    XCTAssertTrue(stopping.canOpen)
    let creating = Dot.Worker(id: 5, state: "creating", task: "Fix")
    XCTAssertFalse(creating.canOpen)
    XCTAssertTrue(creating.canStop)
    let stopped = Dot.Worker(id: 6, state: "done", outcome: "stopped", task: "Fix")
    XCTAssertEqual(stopped.status, "stopped")
    XCTAssertFalse(stopped.canStop)
  }

  func testOpeningSaysWhenTheCommandWentToTheClipboardInstead() throws {
    let opened = try JSONDecoder().decode(WorkerOpened.self, from: Data(#"{"opened":true,"terminal":"Ghostty","command":"cd '/w' && 'opencode2' -s 'ses_1'"}"#.utf8))
    XCTAssertNil(opened.notice)
    let copied = WorkerOpened(opened: false, copied: true, command: "cmd", error: "Ghostty didn't open: denied")
    XCTAssertEqual(copied.notice, "Ghostty didn't open: denied — the command is on your clipboard: cmd")
    let uncopied = WorkerOpened(opened: false, copied: false, command: "cmd", error: "Terminal didn't open: x")
    XCTAssertEqual(uncopied.notice, "Terminal didn't open: x — copy and run: cmd")
  }

  func testStopAsksOnceAndSaysWhatHappens() {
    let text = stopConfirmation(Dot.Worker(id: 2, state: "running", task: "Ship it"), dot: "jojo")
    XCTAssertEqual(text.title, "Stop worker #2?")
    XCTAssertTrue(text.detail.hasPrefix("Ship it\n\n"))
    XCTAssertTrue(text.detail.contains("jojo hears once"))
  }

  func testTheDotHandlingARequestIsNotNeedsYouAndTheRowShowsItsAnswer() throws {
    let jojo = try dot(#"{"name":"jojo","purpose":null,"busy":false,"workers":[{"id":1,"state":"running","outcome":null,"task":"Fix","needs":[],"waiting":["permission"],"answered":null},{"id":2,"state":"running","outcome":null,"task":"Ship","needs":[],"waiting":[],"answered":"Approved once"}],"sessions":[{"request":7,"source":"threads","sessionID":"ses_t","title":"Research","directory":"/r","needs":["question"],"waiting":[],"answered":"Rejected (outcome unknown)"}]}"#)
    XCTAssertEqual(jojo.workers.map(\.line), ["#1 dot handling: permission · Fix", "#2 running · Ship · Approved once"])
    XCTAssertEqual(jojo.sessions?.first?.line, "Threads needs you: question · Research · Rejected (outcome unknown)")
    XCTAssertEqual(jojo.needsYouCount, 1)
  }

  func testUnknownAnswerStillNeedsYouWhileStopIsUnconfirmed() throws {
    let jojo = try dot(#"{"name":"jojo","busy":false,"workers":[{"id":1,"state":"stopping","task":"Fix","needs":["permission"],"answered":"Approved once (outcome unknown)"}]}"#)
    XCTAssertEqual(jojo.needsYouCount, 1)
    XCTAssertEqual(jojo.workers[0].status, "stopping, not confirmed · needs you: permission")
    XCTAssertTrue(jojo.workers[0].canStop)
  }

  func testTheAuditDecodesWhatWasAskedAndWhatBecameOfTheAnswer() throws {
    let json = #"{"requests":[{"id":3,"source":"worker","worker":1,"sessionID":"ses_w","title":"Fix","directory":"/w","kind":"permission","requestID":"per_1","detailText":"{}","answerText":"{\"decision\": \"once\"}","detail":{"kind":"permission","action":"shell","resources":["git push --force"]},"sensitive":false,"state":"escalated","needsYou":true,"reason":"It force-pushes or deletes a remote branch.","answer":{"decision":"once"},"summary":"Approved once (not sent)","actorSession":"ses_jojo","createdAt":1000,"goneAt":null,"queuedAt":2000,"attemptedAt":null,"confirmedAt":null,"escalatedAt":3000},{"id":4,"source":"threads","worker":null,"sessionID":"ses_t","title":"R","directory":"/r","kind":"question","requestID":"frm_1","detailText":"{\"options\": [\"main\", \"dev\"]}","answerText":null,"detail":{"kind":"question","title":"Which?","fields":[{"key":"branch","type":"string","title":"Branch"}]},"sensitive":false,"state":"answered","needsYou":false,"reason":null,"answer":{"decision":"reply","answer":{"branch":"dev"}},"summary":"Answered branch: dev","actorSession":"ses_jojo","createdAt":1000,"goneAt":5000,"queuedAt":2000,"attemptedAt":2100,"confirmedAt":2200,"escalatedAt":null}]}"#
    struct Body: Decodable { let requests: [RequestAudit] }
    let audit = try JSONDecoder().decode(Body.self, from: Data(json.utf8)).requests
    XCTAssertEqual(audit.map(\.line), [
      "#3 permission from worker #1 · escalated to you · Approved once (not sent)",
      "#4 question from Threads · confirmed · Answered branch: dev",
    ])
    XCTAssertEqual(audit.map(\.asked), ["shell: git push --force", "Which? · Branch"])
    XCTAssertTrue(requestTimes(audit[1]).contains("by ses_jojo"))
    XCTAssertTrue(requestTimes(audit[1]).contains("confirmed"))
  }

  func testTheAuditShowsTheCompleteAnswerAndProviderID() throws {
    let json = #"{"id":9,"source":"worker","worker":1,"sessionID":"ses_w","title":"Fix","directory":"/w","kind":"question","requestID":"frm_42","detail":{"kind":"question","title":"Notes?"},"detailText":"{\n  \"fields\": [{\"options\": [{\"value\": \"a\"}]}]\n}","answerText":"{\n  \"decision\": \"reply\",\n  \"answer\": {\"notes\": \"a very long answer that the summary would cut\"}\n}","state":"answered","needsYou":false,"createdAt":1}"#
    let row = try JSONDecoder().decode(RequestAudit.self, from: Data(json.utf8))
    XCTAssertEqual(row.requestID, "frm_42")
    XCTAssertTrue(row.answerText?.contains("a very long answer that the summary would cut") == true)
    XCTAssertTrue(row.detailText.contains("\"value\": \"a\""))
  }

  func testAuditPagesKeepOlderRowsAndAStaleReadCantOverwriteANewerOne() throws {
    func row(_ id: Int, _ state: String) throws -> RequestAudit {
      try JSONDecoder().decode(RequestAudit.self, from: Data(#"{"id":\#(id),"source":"worker","sessionID":"s","title":"t","kind":"permission","requestID":"p\#(id)","detail":{"kind":"permission"},"detailText":"{}","state":"\#(state)","needsYou":false,"createdAt":1}"#.utf8))
    }
    var audit = RequestAuditState()
    let stale = audit.startRead()
    let fresh = audit.startRead()
    audit.apply(fresh, RequestAuditPage(requests: [try row(3, "answered"), try row(2, "open")], next: 2), older: false)
    audit.apply(stale, RequestAuditPage(requests: [try row(3, "queued")], next: nil), older: false)
    XCTAssertEqual(audit.rows.map(\.state), ["answered", "open"])
    XCTAssertEqual(audit.older, 2)
    let older = audit.startRead()
    audit.apply(older, RequestAuditPage(requests: [try row(1, "unknown")], next: nil), older: true)
    XCTAssertEqual(audit.rows.map(\.id), [3, 2, 1])
    XCTAssertNil(audit.older)
    // A later refresh of the newest page keeps the older page and where it ends.
    let refresh = audit.startRead()
    audit.apply(refresh, RequestAuditPage(requests: [try row(4, "open"), try row(3, "answered")], next: 3), older: false)
    XCTAssertEqual(audit.rows.map(\.id), [4, 3, 2, 1])
    XCTAssertNil(audit.older)
  }
}
