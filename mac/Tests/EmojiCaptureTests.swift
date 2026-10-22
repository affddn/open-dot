import XCTest
@testable import open_dot_notch

final class EmojiCaptureTests: XCTestCase {
  private typealias Effect = EmojiCapture.Effect

  func testAChoiceAppliesOnceAndKeepsTheHoldUntilFocusReallyLeaves() {
    var capture = EmojiCapture()
    XCTAssertEqual(capture.handle(.shown), Effect())
    XCTAssertEqual(capture.handle(.choice), Effect(apply: true))
    XCTAssertTrue(capture.holding)
    // A late pick from a picker that's still open is dropped, and the hold stays.
    XCTAssertEqual(capture.handle(.choice), Effect())
    XCTAssertEqual(capture.handle(.ended), Effect())
    XCTAssertEqual(capture.handle(.focusLost), Effect(release: true))
    XCTAssertEqual(capture.handle(.focusLost), Effect())
    XCTAssertEqual(capture.handle(.choice), Effect())
  }

  func testCancelInvalidInputAndTimeoutAfterShowingKeepTheHold() {
    var capture = EmojiCapture()
    _ = capture.handle(.shown)
    XCTAssertEqual(capture.handle(.ended), Effect())
    XCTAssertFalse(capture.capturing)
    XCTAssertTrue(capture.holding)
    XCTAssertEqual(capture.handle(.choice), Effect())
    XCTAssertEqual(capture.handle(.focusLost), Effect(release: true))
  }

  func testNothingToGuardBeforeThePickerShows() {
    var ended = EmojiCapture()
    XCTAssertEqual(ended.handle(.ended), Effect(release: true))
    XCTAssertEqual(ended.handle(.shown), Effect())
    XCTAssertFalse(ended.shown)
    XCTAssertEqual(ended.handle(.focusLost), Effect())

    var failed = EmojiCapture()
    XCTAssertEqual(failed.handle(.focusLost), Effect(release: true))
    XCTAssertEqual(failed.handle(.focusLost), Effect())
    XCTAssertEqual(failed.handle(.choice), Effect())
  }

  func testLosingFocusWhileCapturingReleasesWithoutApplying() {
    var capture = EmojiCapture()
    _ = capture.handle(.shown)
    XCTAssertEqual(capture.handle(.focusLost), Effect(release: true))
    XCTAssertEqual(capture.handle(.choice), Effect())
    XCTAssertFalse(capture.holding)
  }
}
