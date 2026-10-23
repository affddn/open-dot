import AppKit
import XCTest
@testable import open_dot_notch

final class AvatarStateTests: XCTestCase {
  private func dots(_ json: String) throws -> [Dot] {
    try JSONDecoder().decode([Dot].self, from: Data(json.utf8))
  }

  private func listed(_ revisions: [String: String?]) -> [Dot] {
    revisions.keys.sorted().map { name in
      Dot(name: name, purpose: nil, busy: false, workers: [], avatar: revisions[name]!.map { Dot.Avatar(revision: $0) })
    }
  }

  func testDotsDecodeWithAndWithoutAnAvatar() throws {
    let list = try dots(#"[{"name":"jotaro","purpose":null,"busy":false,"workers":[],"sessions":[],"avatar":{"revision":"7-1432014-1.5-1.5"}},{"name":"jolyne","purpose":null,"busy":false,"workers":[],"sessions":[],"avatar":null},{"name":"older","purpose":null,"busy":false,"workers":[]}]"#)
    XCTAssertEqual(list.map(\.avatar), [Dot.Avatar(revision: "7-1432014-1.5-1.5"), nil, nil])
  }

  func testEachRevisionLoadsOnceAndADotWithoutOneShowsNone() {
    var state = AvatarState()
    let loads = state.update(listed(["jotaro": "a", "jolyne": nil]))
    XCTAssertEqual(loads.map { $0.name }, ["jotaro"])
    XCTAssertTrue(state.update(listed(["jotaro": "a", "jolyne": nil])).isEmpty, "A load in flight isn't started twice")
    XCTAssertTrue(state.finish("jotaro", "a", image: NSImage(size: NSSize(width: 1, height: 1))))
    XCTAssertNotNil(state.images["jotaro"])
    XCTAssertNil(state.images["jolyne"])
    XCTAssertTrue(state.update(listed(["jotaro": "a", "jolyne": nil])).isEmpty, "A loaded revision isn't loaded again")
  }

  func testAReplacedFileLoadsAgainAndAStaleLoadIsDropped() {
    var state = AvatarState()
    let old = NSImage(size: NSSize(width: 1, height: 1))
    let new = NSImage(size: NSSize(width: 2, height: 2))
    _ = state.update(listed(["jotaro": "a"]))
    XCTAssertTrue(state.finish("jotaro", "a", image: old))
    _ = state.update(listed(["jotaro": "b"]))
    XCTAssertTrue(state.images["jotaro"] === old, "The old image stays until the new one loads")
    _ = state.update(listed(["jotaro": "c"]))
    XCTAssertFalse(state.finish("jotaro", "b", image: NSImage()), "A load for a replaced revision is dropped")
    XCTAssertTrue(state.images["jotaro"] === old)
    XCTAssertTrue(state.finish("jotaro", "c", image: new))
    XCTAssertTrue(state.images["jotaro"] === new)
  }

  func testADeletedFileClearsAtOnceAndALateLoadCantBringItBack() {
    var state = AvatarState()
    _ = state.update(listed(["jotaro": "a"]))
    XCTAssertTrue(state.finish("jotaro", "a", image: NSImage(size: NSSize(width: 1, height: 1))))
    _ = state.update(listed(["jotaro": "b"]))
    _ = state.update(listed(["jotaro": nil]))
    XCTAssertNil(state.images["jotaro"])
    XCTAssertFalse(state.finish("jotaro", "b", image: NSImage(size: NSSize(width: 1, height: 1))))
    XCTAssertNil(state.images["jotaro"])
    XCTAssertEqual(state.update(listed(["jotaro": "a"])).map { $0.revision }, ["a"], "A file put back loads again")
  }

  func testUndecodableBytesWaitForANewRevisionButAFailedRequestIsRetried() {
    var state = AvatarState()
    _ = state.update(listed(["jotaro": "a"]))
    XCTAssertTrue(state.finish("jotaro", "a", image: nil))
    XCTAssertNil(state.images["jotaro"])
    XCTAssertTrue(state.update(listed(["jotaro": "a"])).isEmpty)
    XCTAssertEqual(state.update(listed(["jotaro": "b"])).map { $0.revision }, ["b"])
    // A 401, 404, 5xx or lost request: the next dots poll asks again.
    state.abandon("jotaro", "b")
    XCTAssertEqual(state.update(listed(["jotaro": "b"])).map { $0.revision }, ["b"])
    XCTAssertTrue(state.finish("jotaro", "b", image: NSImage(size: NSSize(width: 1, height: 1))))
    XCTAssertNotNil(state.images["jotaro"])
  }
}
