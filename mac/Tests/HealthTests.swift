import AppKit
import XCTest
@testable import open_dot_notch

/// The Health tab: the daemon's report as `open-dot doctor --json` gives it, decoded and shown from
/// a dot tab's menu, with no daemon or window.
final class HealthTests: XCTestCase {
  func testDecodesTheDoctorReportAndReadsUnknownStatusesAsUnknown() throws {
    let json = """
      {"schemaVersion":1,"checkedAt":1800000000000,"sampledAt":1799999880000,"checks":[
        {"id":"daemon","status":"healthy","summary":"The daemon is running and answered this check."},
        {"id":"deliveries","status":"unknown","summary":"1 sends have an unknown outcome.",
         "nextStep":"Check the dot's chat.","counts":{"outboxUnknown":1}},
        {"id":"feed.github","status":"stale","summary":"No GitHub feed pass has finished for over 5 minutes.",
         "lastSuccessAt":1799999600000},
        {"id":"slack.notices","status":"disabled","summary":"Off."},
        {"id":"feed.linear","status":"not_configured","summary":"Not set up."},
        {"id":"future","status":"degraded","summary":"A status from a newer daemon."}
      ]}
      """
    let report = try API.decode(HealthReport.self, Data(json.utf8), log: { _ in })
    XCTAssertEqual(report.schemaVersion, 1)
    XCTAssertEqual(report.checkedAt, 1_800_000_000_000)
    XCTAssertEqual(report.sampledAt, 1_799_999_880_000)
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    XCTAssertEqual(healthTimes(report, now: now), "Checked just now · database sampled 2m ago")
    XCTAssertEqual(
      healthTimes(HealthReport(schemaVersion: 1, checkedAt: 1_800_000_000_000, checks: []), now: now),
      "Checked just now · no database sample")
    let failed = try API.decode(
      HealthReport.self,
      Data(#"{"schemaVersion":1,"checkedAt":1800000000000,"sampleUnavailable":"failed","checks":[]}"#.utf8),
      log: { _ in })
    XCTAssertNil(failed.sampledAt)
    XCTAssertEqual(healthTimes(failed, now: now), "Checked just now · database sample failed")
    XCTAssertEqual(report.checks.map(\.id), ["daemon", "deliveries", "feed.github", "slack.notices", "feed.linear", "future"])
    XCTAssertEqual(report.checks.map(\.label), ["Healthy", "Unknown", "Stale", "Off", "Not set up", "Unknown"])
    XCTAssertEqual(report.checks[1].nextStep, "Check the dot's chat.")
    XCTAssertEqual(report.checks[2].lastSuccessAt, 1_799_999_600_000)
    XCTAssertNil(report.checks[0].nextStep)

    var logged: [String] = []
    XCTAssertThrowsError(try API.decode(HealthReport.self, Data(#"{"schemaVersion":1,"checks":[]}"#.utf8), log: { logged.append($0) }))
    XCTAssertEqual(logged, ["open-dot-notch: couldn't decode HealthReport at checkedAt (keyNotFound)"])
  }

  @MainActor func testHealthIsTheMenusFourthItemAndOnlyReadsTheReport() async throws {
    let store = try isolatedStore()
    var reads = 0
    var chatReads = 0
    store.latestPage = { _ in
      chatReads += 1
      throw APIError.unreachable
    }
    store.healthReport = {
      reads += 1
      return HealthReport(schemaVersion: 1, checkedAt: 1, checks: [HealthCheck(id: "daemon", status: "healthy", summary: "Running.")])
    }
    let menu = dotMenu(store, dot: "jolyne")
    XCTAssertEqual(menu.items.map { $0.identifier?.rawValue }[3], "dot-menu-health")
    let item = try XCTUnwrap(menu.items.first { $0.identifier?.rawValue == "dot-menu-health" })
    XCTAssertTrue(NSApplication.shared.sendAction(try XCTUnwrap(item.action), to: item.target, from: item))
    await eventually { store.selected == "jolyne" && store.pane == .health && store.health?.checks.count == 1 }
    await Task.yield()
    XCTAssertEqual(reads, 1)
    XCTAssertEqual(chatReads, 0, "Opening Health must not request database-backed chat history")
    XCTAssertFalse(store.showingLibrary)
    XCTAssertFalse(store.showingMemory)
    XCTAssertFalse(store.showingInstructions)
    XCTAssertNil(store.healthError)

    store.show(.chat)
    XCTAssertEqual(store.pane, .chat)
    XCTAssertEqual(store.selected, "jolyne")
  }

  @MainActor func testAFailedReadKeepsTheLastReportAndALateAnswerIsDropped() async throws {
    let store = try isolatedStore()
    let first = HealthReport(schemaVersion: 1, checkedAt: 1, checks: [HealthCheck(id: "daemon", status: "healthy", summary: "Running.")])
    store.healthReport = { first }
    await store.refreshHealth()
    XCTAssertEqual(store.health, first)

    store.healthReport = { throw APIError.unreachable }
    await store.refreshHealth()
    XCTAssertEqual(store.health, first, "What's shown stays")
    XCTAssertEqual(store.healthError, "Couldn't run the health check. open-dot daemon isn't running")

    // A slow read that a newer one overtakes never replaces the newer answer.
    let newer = HealthReport(schemaVersion: 1, checkedAt: 3, checks: [])
    var started = false
    var held = true
    store.healthReport = {
      started = true
      while held { try await Task.sleep(for: .milliseconds(5)) }
      return HealthReport(schemaVersion: 1, checkedAt: 2, checks: [])
    }
    let slow = Task { await store.refreshHealth() }
    await eventually { started }
    store.healthReport = { newer }
    await store.refreshHealth()
    held = false
    await slow.value
    XCTAssertEqual(store.health, newer)
    XCTAssertNil(store.healthError)
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
