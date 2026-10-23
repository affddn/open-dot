import XCTest
@testable import open_dot_notch

final class ComposerTests: XCTestCase {
  private let line: CGFloat = 16

  private func height(lines: CGFloat, trailingNewline: Bool = false) -> DraftHeight {
    DraftHeight(used: lines * line, line: line, trailingNewline: trailingNewline)
  }

  func testAnEmptyOrShortDraftIsTwoLinesTallAndFillsTheBox() {
    for lines: CGFloat in [0, 1, 2] {
      XCTAssertEqual(height(lines: lines).visible, 38, "\(lines) lines")
      XCTAssertEqual(height(lines: lines).document, 38, "\(lines) lines")
    }
  }

  func testTheBoxGrowsWithTheTextUpToSixLines() {
    XCTAssertEqual(height(lines: 3).visible, 54)
    XCTAssertEqual(height(lines: 6).visible, 102)
    XCTAssertEqual(height(lines: 6).document, 102)
  }

  func testPastSixLinesTheDocumentKeepsGrowingSoTheBoxScrolls() {
    XCTAssertEqual(height(lines: 7).visible, 102)
    XCTAssertEqual(height(lines: 10).visible, 102)
    XCTAssertEqual(height(lines: 10).document, 166)
  }

  func testATrailingNewlineCountsAsALine() {
    XCTAssertEqual(height(lines: 2, trailingNewline: true).visible, 54)
    XCTAssertEqual(height(lines: 5, trailingNewline: true).visible, 102)
    XCTAssertEqual(height(lines: 6, trailingNewline: true).visible, 102)
    XCTAssertEqual(height(lines: 6, trailingNewline: true).document, 118)
  }
}
