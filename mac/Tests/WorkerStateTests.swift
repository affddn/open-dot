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
    let stopping = Dot.Worker(id: 4, state: "stopping", task: "Fix", needs: ["permission"])
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
}
