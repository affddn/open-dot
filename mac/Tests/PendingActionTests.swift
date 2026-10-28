import XCTest
@testable import open_dot_notch

final class PendingActionTests: XCTestCase {
  func testSendNowOnlyWhileItWaitsBehindTheTurnAndCancelUntilTheDotHasIt() {
    XCTAssertTrue(Store.pendingActions(status: "sending", delivery: "auto") == (true, true))
    XCTAssertTrue(Store.pendingActions(status: "sent", delivery: "queue") == (true, true))
    XCTAssertTrue(Store.pendingActions(status: "sent", delivery: "steer") == (false, true))
    XCTAssertTrue(Store.pendingActions(status: "confirming", delivery: "steer") == (false, false))
    XCTAssertTrue(Store.pendingActions(status: nil, delivery: nil) == (false, false))
  }

  func testThePageCarriesEachSendsDelivery() throws {
    let json = #"{"messages":[],"sessionID":"ses_1","next":null,"pending":[{"id":"msg_a","status":"sent","delivery":"queue"},{"id":"msg_b","status":"sending"}]}"#
    let page = try JSONDecoder().decode(MessagePage.self, from: Data(json.utf8))
    XCTAssertEqual(page.statuses, ["msg_a": "sent", "msg_b": "sending"])
    XCTAssertEqual(page.deliveries, ["msg_a": "queue"])
  }
}
