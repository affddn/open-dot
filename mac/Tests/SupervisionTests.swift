import XCTest
@testable import open_dot_notch

final class SupervisionTests: XCTestCase {
  private let now = Date(timeIntervalSince1970: 10_000)

  private func binding(state: String, created: Double, activated: Double?) -> Supervision {
    Supervision(id: 1, sessionID: "ses_owner", directory: "/work", mode: "send", state: state, busyMinutes: 30, createdAt: created, activatedAt: activated)
  }

  func testTheRowShowsWhenItWasAskedForCreatedAndApproved() {
    XCTAssertEqual(supervisionTimes(binding(state: "requested", created: 9_400_000, activated: nil), now: now), "Requested 10m ago")
    XCTAssertEqual(supervisionTimes(binding(state: "active", created: 2_800_000, activated: 2_800_000), now: now), "Created 2h ago")
    XCTAssertEqual(supervisionTimes(binding(state: "active", created: 2_800_000, activated: 9_970_000), now: now), "Created 2h ago, approved just now")
  }

  func testMemoryFromADaemonWithSupervisionsDecodesThem() throws {
    let json = #"{"notes":[],"responsibilities":[],"reminders":[],"supervisions":[{"id":3,"sessionID":"ses_owner","directory":"/work","mode":"watch","state":"requested","busyMinutes":30,"createdAt":1,"activatedAt":null}]}"#
    let memory = try JSONDecoder().decode(Memory.self, from: Data(json.utf8))
    XCTAssertEqual(memory.supervisions?.first?.modeTitle, "watch only")
    let older = try JSONDecoder().decode(Memory.self, from: Data(#"{"notes":[],"responsibilities":[],"reminders":[]}"#.utf8))
    XCTAssertNil(older.supervisions)
  }
}
