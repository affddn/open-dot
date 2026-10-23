import AppKit
import XCTest
@testable import open_dot_notch

final class InstructionsStateTests: XCTestCase {
  private func file(_ content: String, _ revision: String, canRevert: Bool = false) -> Instructions {
    Instructions(content: content, revision: revision, canRevert: canRevert)
  }

  private func loaded(_ content: String = "# jojo\n", _ revision: String = "r1", canRevert: Bool = false) -> InstructionsState {
    var state = InstructionsState()
    XCTAssertTrue(state.beginRead(discarding: false))
    state.finishRead(.success(file(content, revision, canRevert: canRevert)))
    return state
  }

  func testDecodesEachAnswer() throws {
    let body = Data(##"{"content":"# jojo\n","revision":"abc","canRevert":true}"##.utf8)
    XCTAssertEqual(try JSONDecoder().decode(Instructions.self, from: body), file("# jojo\n", "abc", canRevert: true))
    XCTAssertEqual(try instructionsOutcome(status: 200, data: body), .saved(file("# jojo\n", "abc", canRevert: true)))

    let conflict = Data(#"{"error":"changed","current":{"content":"disk","revision":"r2","canRevert":false}}"#.utf8)
    XCTAssertEqual(try instructionsOutcome(status: 409, data: conflict), .conflict(file("disk", "r2"), "changed"))

    // A 200 that can't be read may still have saved; a refusal says why and changed nothing.
    XCTAssertThrowsError(try instructionsOutcome(status: 200, data: Data("{}".utf8))) { error in
      guard case .lost = error as? APIError else { return XCTFail("\(error)") }
    }
    XCTAssertThrowsError(try instructionsOutcome(status: 409, data: Data(#"{"error":"changed"}"#.utf8))) { error in
      guard case .server = error as? APIError else { return XCTFail("\(error)") }
    }
    XCTAssertThrowsError(try instructionsOutcome(status: 413, data: Data(#"{"error":"Too large"}"#.utf8))) { error in
      guard case .server(let message) = error as? APIError else { return XCTFail("\(error)") }
      XCTAssertEqual(message, "Too large")
    }
  }

  func testSavesSendTheLoadedRevisionOnceAtATime() throws {
    var state = loaded()
    XCTAssertFalse(state.canSave, "Nothing changed yet")
    XCTAssertNil(state.beginSave(overwrite: false))
    XCTAssertTrue(state.edit("# jojo\nBe brief.\n"))
    XCTAssertTrue(state.dirty)
    let request = try XCTUnwrap(state.beginSave(overwrite: false))
    XCTAssertEqual(request.content, "# jojo\nBe brief.\n")
    XCTAssertEqual(request.revision, "r1")
    XCTAssertNil(state.beginSave(overwrite: false), "A second click while saving sends nothing")
    XCTAssertFalse(state.beginRead(discarding: true))
    state.finish(.outcome(.saved(file("# jojo\nBe brief.\n", "r2", canRevert: true))))
    XCTAssertFalse(state.dirty)
    XCTAssertEqual(state.base?.revision, "r2")
    XCTAssertTrue(state.canRevert)
  }

  func testAConflictKeepsTheDraftAndOverwriteUsesTheConflictsRevision() throws {
    var state = loaded()
    XCTAssertTrue(state.edit("mine"))
    _ = try XCTUnwrap(state.beginSave(overwrite: false))
    state.finish(.outcome(.conflict(file("disk", "r2"), "changed")))
    XCTAssertEqual(state.draft, "mine")
    XCTAssertEqual(state.conflict, file("disk", "r2"))
    XCTAssertFalse(state.canSave, "A plain save would carry the stale revision")
    XCTAssertNil(state.beginSave(overwrite: false))
    XCTAssertFalse(state.canRevert)
    let overwrite = try XCTUnwrap(state.beginSave(overwrite: true))
    XCTAssertEqual(overwrite.revision, "r2")
    XCTAssertEqual(overwrite.content, "mine")
    state.finish(.outcome(.saved(file("mine", "r3", canRevert: true))))
    XCTAssertNil(state.conflict)
    XCTAssertFalse(state.dirty)
  }

  func testAnUnknownOutcomeKeepsTheDraftAndAManualRetryThatAlreadyLandedIsRecognized() throws {
    var state = loaded()
    XCTAssertTrue(state.edit("mine"))
    _ = try XCTUnwrap(state.beginSave(overwrite: false))
    state.finish(.failed("Outcome unknown"))
    XCTAssertEqual(state.error, "Outcome unknown")
    XCTAssertEqual(state.draft, "mine")
    XCTAssertEqual(state.base?.revision, "r1")
    // The owner saves again at the same revision; the daemon refuses it with the text that landed.
    let retry = try XCTUnwrap(state.beginSave(overwrite: false))
    XCTAssertEqual(retry.revision, "r1")
    state.finish(.outcome(.conflict(file("mine", "r2", canRevert: true), "changed")))
    XCTAssertNil(state.conflict)
    XCTAssertFalse(state.dirty)
    XCTAssertEqual(state.base?.revision, "r2")
  }

  func testRevertAndReloadReplaceTheDraftOnlyWhenAsked() throws {
    var state = loaded(canRevert: true)
    XCTAssertTrue(state.edit("unsaved"))
    XCTAssertFalse(state.beginRead(discarding: false), "Showing the tab again never drops edits")
    XCTAssertEqual(state.beginRevert(), "r1")
    state.finish(.outcome(.conflict(file("disk", "r2"), "changed")))
    XCTAssertFalse(state.canOverwrite, "A refused revert has nothing to overwrite with")
    XCTAssertEqual(state.draft, "unsaved")
    XCTAssertTrue(state.beginRead(discarding: true))
    state.finishRead(.success(file("disk", "r2", canRevert: true)))
    XCTAssertEqual(state.draft, "disk")
    XCTAssertNil(state.conflict)
    XCTAssertEqual(state.beginRevert(), "r2")
    state.finish(.outcome(.saved(file("older", "r0"))))
    XCTAssertEqual(state.draft, "older")
    XCTAssertFalse(state.canRevert)
  }

  func testCancelGoesBackAndOversizedOrNULTextIsNeverSent() {
    var state = loaded()
    XCTAssertTrue(state.edit(String(repeating: "é", count: instructionsLimit / 2) + "a"))
    XCTAssertTrue(state.tooLarge)
    XCTAssertFalse(state.canSave)
    XCTAssertNil(state.beginSave(overwrite: false))
    XCTAssertTrue(state.edit("a\u{0}b"))
    XCTAssertNil(state.beginSave(overwrite: false))
    XCTAssertNotNil(state.error)
    state.discard()
    XCTAssertEqual(state.draft, "# jojo\n")
    XCTAssertFalse(state.dirty)
  }

  func testEditsAreRefusedWhileARequestRunsAndAnswersKeepWhatWasSent() throws {
    var state = InstructionsState()
    XCTAssertFalse(state.edit("before load"), "Nothing to edit until a file is loaded")
    XCTAssertTrue(state.beginRead(discarding: false))
    XCTAssertFalse(state.edit("during load"))
    state.finishRead(.success(file("# jojo\n", "r1", canRevert: true)))
    XCTAssertEqual(state.draft, "# jojo\n")

    XCTAssertTrue(state.edit("mine"), "Typing while idle is kept")
    let sent = try XCTUnwrap(state.beginSave(overwrite: false))
    XCTAssertFalse(state.edit("typed during save"))
    XCTAssertEqual(state.draft, "mine")
    XCTAssertEqual(state.busy, .saving("mine"))
    state.finish(.failed("Not saved"))
    XCTAssertEqual(state.draft, sent.content, "A failure keeps exactly the text that was sent")

    _ = try XCTUnwrap(state.beginSave(overwrite: false))
    XCTAssertFalse(state.edit("typed during save"))
    state.finish(.outcome(.conflict(file("disk", "r2"), "changed")))
    XCTAssertEqual(state.draft, "mine", "A conflict keeps exactly the text that was sent")
    let overwrite = try XCTUnwrap(state.beginSave(overwrite: true))
    XCTAssertFalse(state.edit("typed during overwrite"))
    XCTAssertEqual(overwrite.content, "mine")
    state.finish(.outcome(.saved(file("mine", "r3", canRevert: true))))
    XCTAssertEqual(state.draft, "mine")

    XCTAssertEqual(state.beginRevert(), "r3")
    XCTAssertFalse(state.edit("typed during revert"))
    state.finish(.outcome(.saved(file("# jojo\n", "r1"))))
    XCTAssertEqual(state.draft, "# jojo\n")
    XCTAssertTrue(state.edit("idle again"))
    XCTAssertEqual(state.draft, "idle again")
  }

  /// Object-only: no window or app is shown. The undo step sets the text, as NSTextView's own do,
  /// past `isEditable`.
  @MainActor func testUndoAndRedoDoNothingAndAreDisabledWhileTheEditorIsReadOnly() async {
    let view = PlainTextView()
    view.string = "after"
    view.history.groupsByEvent = false
    view.history.beginUndoGrouping()
    view.history.registerUndo(withTarget: view, selector: #selector(setter: NSText.string), object: "before")
    view.history.endUndoGrouping()
    let undo = NSMenuItem(title: "Undo", action: #selector(PlainTextView.undo(_:)), keyEquivalent: "z")
    let redo = NSMenuItem(title: "Redo", action: #selector(PlainTextView.redo(_:)), keyEquivalent: "Z")

    view.isEditable = false
    XCTAssertFalse(view.validateMenuItem(undo))
    view.undo(nil)
    XCTAssertEqual(view.string, "after")
    XCTAssertTrue(view.history.canUndo, "The step is still there for when editing resumes")

    view.isEditable = true
    XCTAssertTrue(view.validateMenuItem(undo))
    view.undo(nil)
    XCTAssertEqual(view.string, "before")
    XCTAssertFalse(view.history.canUndo)
    view.isEditable = false
    XCTAssertFalse(view.validateMenuItem(redo))
    view.redo(nil)
    XCTAssertEqual(view.string, "before")
  }
}
