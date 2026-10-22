import XCTest
@testable import open_dot_notch

final class TapbackTests: XCTestCase {
  func testSecondRowIsAlwaysFiveRecentsThenUnusedFallbacks() {
    XCTAssertEqual(recentTapbacks([]), ["🧐", "✋", "👀", "🧠", "🔥"])
    XCTAssertEqual(recentTapbacks(["🔥"]), ["🔥", "🧐", "✋", "👀", "🧠"])
    let recent = ["🦀", "🐙", "🌵", "🇯🇵", "🔥"]
    XCTAssertEqual(recentTapbacks(recent), recent)
    XCTAssertEqual(recentTapbacks(recent + ["🧠"]), recent)
  }

  func testOnlyASelectionNeitherRowShowsIsListedSeparately() {
    let row = ["🦀", "🐙", "🌵", "🇯🇵", "🔥"]
    XCTAssertNil(unlistedTapback(nil, row: row))
    XCTAssertNil(unlistedTapback("🌵", row: row))
    XCTAssertNil(unlistedTapback("‼️", row: row))
    XCTAssertEqual(unlistedTapback("👩🏽‍💻", row: row), "👩🏽‍💻")
    // The row itself never changes to show it.
    XCTAssertEqual(recentTapbacks(row), row)
  }

  func testOnlyOneCharacterDrawnAsAnEmojiIsSent() {
    for emoji in ["❤️", "‼️", "🔥", "🇯🇵", "👍🏽", "👩🏽‍💻", "🏳️‍🌈", "1️⃣", "🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}"] {
      XCTAssertTrue(looksLikeEmoji(emoji), emoji)
    }
    for text in ["", "a", "1", "❤", "‼", "\t", "\n", "🔥🔥", "🔥 ", "ok"] {
      XCTAssertFalse(looksLikeEmoji(text), text)
    }
  }
}
