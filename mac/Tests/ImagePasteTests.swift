import AppKit
import XCTest
@testable import open_dot_notch

/// Paste and drop are the only ways to attach images, so they must keep working on their own.
/// Each test uses a private pasteboard, never the user's clipboard.
final class ImagePasteTests: XCTestCase {
  private func image(_ type: NSBitmapImageRep.FileType) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 4, pixelsHigh: 4, bitsPerSample: 8,
      samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    rep.bitmapData!.initialize(repeating: 0, count: rep.bytesPerRow * rep.pixelsHigh)
    return rep.representation(using: type, properties: [:])!
  }

  @MainActor func testAPastedImageGoesToTheDotItWasPastedInto() async {
    let board = NSPasteboard.withUniqueName()
    defer { board.releaseGlobally() }
    board.clearContents()
    board.setData(image(.png), forType: .png)
    let store = Store()
    store.selected = "ollie"
    XCTAssertTrue(store.pasteImages(board, to: "jojo"))
    XCTAssertEqual(store.draftImages["jojo"]?.map(\.file.mime), ["image/png"])
    XCTAssertNil(store.draftImages["ollie"])
    XCTAssertNil(store.imageErrors["jojo"])
  }

  @MainActor func testAScreenshotTIFFIsAttachedAsPNG() async {
    let board = NSPasteboard.withUniqueName()
    defer { board.releaseGlobally() }
    board.clearContents()
    board.setData(image(.tiff), forType: .tiff)
    let store = Store()
    XCTAssertTrue(store.pasteImages(board, to: "jojo"))
    XCTAssertEqual(store.draftImages["jojo"]?.map(\.file.mime), ["image/png"])
    XCTAssertEqual(store.draftImages["jojo"]?.map(\.file.name), ["Pasted image.png"])
  }

  @MainActor func testPlainTextIsLeftForTheEditorToPaste() async {
    let board = NSPasteboard.withUniqueName()
    defer { board.releaseGlobally() }
    board.clearContents()
    board.setString("hello", forType: .string)
    let store = Store()
    XCTAssertFalse(store.pasteImages(board, to: "jojo"))
    XCTAssertNil(store.draftImages["jojo"])
    XCTAssertNil(store.imageErrors["jojo"])
  }

  @MainActor func testADroppedImageFileIsAttached() async throws {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).png")
    try image(.png).write(to: url)
    defer { try? FileManager.default.removeItem(at: url) }
    let board = NSPasteboard.withUniqueName()
    defer { board.releaseGlobally() }
    board.clearContents()
    board.writeObjects([url as NSURL])
    let store = Store()
    XCTAssertTrue(store.pasteImages(board, to: "jojo"))
    XCTAssertEqual(store.draftImages["jojo"]?.map(\.file.name), [url.lastPathComponent])
    XCTAssertNil(store.imageErrors["jojo"])
  }
}
