import XCTest
@testable import open_dot_notch

final class FeedStateTests: XCTestCase {
  private func item(_ id: Int) -> FeedItem {
    FeedItem(id: id, source: "github", reason: "Mentioned", title: "Item \(id)", context: "acme/app", url: nil, time: Double(id), handedTo: nil)
  }

  private func shown(_ state: FeedState) -> [Int] { state.items.map(\.id) }

  private func loaded(_ ids: [Int]) -> FeedState {
    var state = FeedState()
    XCTAssertTrue(state.apply(state.startPoll(), ids.map(item)))
    return state
  }

  func testAPollBegunBeforeAClearCantBringItBackAfterANewerPollSettlesIt() {
    var state = loaded([1, 2])
    let a = state.startPoll()
    let sent = state.items
    state.dismiss(sent.map(\.id))
    XCTAssertEqual(shown(state), [])
    state.finish(sent, dismissed: [1, 2]) { _ in "unused" }
    // B begins after the clear succeeded and answers first, without the cleared items.
    let b = state.startPoll()
    XCTAssertTrue(state.apply(b, [item(3)]))
    XCTAssertEqual(shown(state), [3])
    XCTAssertFalse(state.isCurrent(a), "An older poll's error must not hide the newer feed either")
    // A read the feed before the clear, so it still lists them. It's older than B, so it's dropped.
    XCTAssertFalse(state.apply(a, [item(1), item(2)]))
    XCTAssertEqual(shown(state), [3])
  }

  func testAPollInFlightDuringTheClearKeepsClearedItemsHiddenUntilAFreshPoll() {
    var state = loaded([1, 2])
    let sent = state.items
    state.dismiss([1, 2])
    let during = state.startPoll()
    state.finish(sent, dismissed: [1, 2]) { _ in "unused" }
    XCTAssertTrue(state.apply(during, [item(1), item(2), item(3)]))
    XCTAssertEqual(shown(state), [3])
    // A poll begun after the success settles them; new activity could then bring one back.
    XCTAssertTrue(state.apply(state.startPoll(), [item(3)]))
    XCTAssertTrue(state.apply(state.startPoll(), [item(1), item(3)]))
    XCTAssertEqual(shown(state), [1, 3])
  }

  func testAPartialFailureRestoresOnlyFailedCapturedItemsAndKeepsNewArrivals() {
    var state = loaded([1, 2, 3])
    let sent = state.items
    state.dismiss([1, 2, 3])
    // Item 4 arrives while the request is out.
    XCTAssertTrue(state.apply(state.startPoll(), [item(1), item(2), item(3), item(4)]))
    XCTAssertEqual(shown(state), [4])
    state.finish(sent, dismissed: [1, 3]) { _ in "There's no such feed item." }
    XCTAssertEqual(shown(state), [2, 4])
    XCTAssertEqual(state.errors, [2: "There's no such feed item."])
  }

  func testAFailureSurvivesAnOlderPollAndANetworkFailureRestoresEveryItem() {
    var state = loaded([1, 2])
    let sent = state.items
    state.dismiss([1, 2])
    let before = state.startPoll()
    state.finish(sent, dismissed: []) { _ in "open-dot daemon isn't running" }
    XCTAssertEqual(shown(state), [1, 2])
    // The older poll no longer lists item 2, but it can't erase the failure shown since.
    XCTAssertTrue(state.apply(before, [item(1), item(5)]))
    XCTAssertEqual(shown(state), [1, 2, 5])
    XCTAssertEqual(state.errors, [1: "open-dot daemon isn't running", 2: "open-dot daemon isn't running"])
    // A poll begun after the failure is current, so it decides what's unread.
    XCTAssertTrue(state.apply(state.startPoll(), [item(1), item(5)]))
    XCTAssertEqual(shown(state), [1, 5])
  }

  func testDismissingAgainClearsTheErrorAndSingleDismissalStillWorks() {
    var state = loaded([1, 2])
    state.dismiss([1])
    state.finish([item(1)], dismissed: []) { _ in "failed" }
    XCTAssertEqual(state.errors, [1: "failed"])
    state.dismiss([1])
    XCTAssertEqual(state.errors, [:])
    XCTAssertEqual(shown(state), [2])
    let during = state.startPoll()
    state.finish([item(1)], dismissed: [1]) { _ in "unused" }
    XCTAssertTrue(state.apply(during, [item(1), item(2)]))
    XCTAssertEqual(shown(state), [2])
    XCTAssertEqual(state.errors, [:])
  }

  func testLostClearResponseKeepsEveryRenderedSnapshotBoundedWithoutDroppingOverflow() {
    for pollFinishesFirst in [true, false] {
      var state = loaded(Array(1...1000))
      let sent = state.items
      state.dismiss(sent.map(\.id))
      let during = state.startPoll()
      if pollFinishesFirst { XCTAssertTrue(state.apply(during, [item(1001)])) }
      state.finish(sent, dismissed: []) { _ in "Response lost" }
      if !pollFinishesFirst { XCTAssertTrue(state.apply(during, [item(1001)])) }
      XCTAssertEqual(shown(state), Array(1...1000))
      XCTAssertEqual(state.overflowCount, 1)
      XCTAssertEqual(state.errors.count, 1000)
      // A retry captures the whole displayed snapshot, not an oversized list truncated at send.
      let retry = state.items
      state.dismiss(retry.map(\.id))
      XCTAssertEqual(shown(state), [1001], "Overflow stays available for the next snapshot")
      XCTAssertEqual(state.overflowCount, 0)
      state.finish(retry, dismissed: Set(retry.map(\.id))) { _ in "unused" }
      XCTAssertEqual(shown(state), [1001])
    }
  }
}
