import XCTest
@testable import open_dot_notch

final class ResponsibilityScheduleTests: XCTestCase {
  private func decode(_ fields: String = "", status: String = "active") throws -> MemoryResponsibility {
    let json = """
      {"id":26,"version":2,"updatedAt":1792742400000,"updatedBy":"scheduler",
       "goal":"Inbox zero","nextAction":"Triage","status":"\(status)"\(fields)}
      """
    return try JSONDecoder().decode(MemoryResponsibility.self, from: Data(json.utf8))
  }

  func testOlderDaemonMayOmitBothScheduleFields() throws {
    let item = try decode()
    XCTAssertNil(item.schedule)
    XCTAssertNil(item.nextRunAt)
    XCTAssertEqual(item.goal, "Inbox zero")
    XCTAssertEqual(item.nextAction, "Triage")
  }

  func testUnscheduledResponsibilityDecodesExplicitNulls() throws {
    let item = try decode(",\"schedule\":null,\"nextRunAt\":null")
    XCTAssertNil(item.schedule)
    XCTAssertNil(item.nextRunAt)
  }

  func testIntervalDecodesAndKeepsMillisecondNextRun() throws {
    let item = try decode(",\"schedule\":{\"kind\":\"interval\",\"everyMinutes\":30},\"nextRunAt\":1792744200000")
    XCTAssertEqual(item.schedule?.kind, "interval")
    XCTAssertEqual(item.schedule?.everyMinutes, 30)
    XCTAssertEqual(item.schedule?.summary, "Every 30 min")
    XCTAssertEqual(item.nextRunAt, 1_792_744_200_000)
  }

  func testDailyScheduleDecodesWithoutANextRunField() throws {
    let item = try decode(",\"schedule\":{\"kind\":\"daily\",\"time\":\"09:00\"}")
    XCTAssertEqual(item.schedule?.summary, "Daily at 09:00")
    XCTAssertNil(item.nextRunAt)
  }

  func testWeeklyScheduleSummariesNameTheSelectedDays() throws {
    let cases = [
      ("[1,2,3,4,5]", "Weekdays at 09:00"),
      ("[0,6]", "Weekends at 09:00"),
      ("[0,1,2,3,4,5,6]", "Every day at 09:00"),
      ("[1,3,5]", "Mon, Wed, Fri at 09:00"),
    ]
    for (days, summary) in cases {
      let item = try decode(",\"schedule\":{\"kind\":\"weekly\",\"days\":\(days),\"time\":\"09:00\"},\"nextRunAt\":null")
      XCTAssertEqual(item.schedule?.summary, summary)
      XCTAssertNil(item.nextRunAt)
    }
  }

  func testDoneAndDroppedKeepTheirScheduleWithoutANextRun() throws {
    for status in ["done", "dropped"] {
      let item = try decode(",\"schedule\":{\"kind\":\"weekly\",\"days\":[1,2,3,4,5],\"time\":\"09:00\"},\"nextRunAt\":null", status: status)
      XCTAssertEqual(item.status, status)
      XCTAssertEqual(item.schedule?.summary, "Weekdays at 09:00")
      XCTAssertNil(item.nextRunAt)
      var draft = MemoryDraft(.responsibility(item))
      draft.status = "active"
      XCTAssertEqual(try draft.changes() as NSDictionary?, ["status": "active"] as NSDictionary)
    }
  }

  func testMemorySnapshotDecodesScheduledAndLegacyRowsTogether() throws {
    let scheduled = try decode(",\"schedule\":{\"kind\":\"interval\",\"everyMinutes\":10},\"nextRunAt\":1792743000000")
    let json = """
      {"notes":[],"reminders":[],"responsibilities":[
       {"id":26,"version":2,"updatedAt":1792742400000,"updatedBy":"scheduler",
        "goal":"Inbox zero","nextAction":"Triage","status":"active",
        "schedule":{"kind":"interval","everyMinutes":10},"nextRunAt":1792743000000},
       {"id":27,"version":1,"updatedAt":0,"updatedBy":"dot",
        "goal":"Ship","nextAction":"Write","status":"active"}]}
      """
    let snapshot = try JSONDecoder().decode(Memory.self, from: Data(json.utf8))
    XCTAssertEqual(snapshot.responsibilities.count, 2)
    XCTAssertEqual(snapshot.responsibilities.first, scheduled)
    XCTAssertNil(snapshot.responsibilities.last?.schedule)
    var state = MemoryState()
    XCTAssertTrue(state.apply(state.startRead(), snapshot))
    XCTAssertEqual(state.memory?.responsibilities.first?.nextRunAt, 1_792_743_000_000)
  }
}
