import XCTest
@testable import open_dot_notch

final class FeedTriggerTests: XCTestCase {
  func testPreviewDoesNotClaimAdmissionOrPromiseAWake() {
    let event = TriggerEvent(sourceID: "T1", reason: "Review requested", repository: "opzero1/open-dot", title: "Review", url: nil, updatedAt: 1)
    XCTAssertEqual(triggerOutcome(.init(event: event, outcome: "queued")), "a wake was queued; check its delivery status")
    XCTAssertEqual(triggerOutcome(.init(event: event, outcome: "pending")), "awaiting the next check of the binding, responsibility and wake limits")
  }

  func testADraftSendsOnlyWhatTheDaemonAcceptsInOneOrder() throws {
    var draft = TriggerDraft()
    XCTAssertThrowsError(try draft.fields(), "No responsibility chosen")
    draft.responsibility = 3
    draft.repository = " OpZero1/Open-Dot "
    draft.reasons = ["Mentioned", "Review requested"]
    draft.task = "  Review it.  "
    let fields = try draft.fields()
    XCTAssertEqual(fields["repository"] as? String, "opzero1/open-dot")
    XCTAssertEqual(fields["reasons"] as? [String], ["Review requested", "Mentioned"])
    XCTAssertEqual(fields["task"] as? String, "Review it.")
    draft.repository = "https://github.com/opzero1/open-dot"
    XCTAssertThrowsError(try draft.fields())
    draft.repository = "opzero1/open-dot"
    draft.reasons = []
    XCTAssertThrowsError(try draft.fields())
  }

  func testTheConfirmationShowsTheExactFilterInstructionDestinationAndRevision() throws {
    let json = """
      {"id":7,"responsibility":3,"sessionID":"ses_jojo","source":"github","repository":"opzero1/open-dot",
       "reasons":["Review requested"],"task":"Review it.\\nThen tell me.","revision":"\(String(repeating: "a", count: 64))",
       "state":"draft","createdAt":1,"confirmedAt":null,"updatedAt":1,"baselineAt":null,
       "lastWake":{"messageID":"msg_1","at":0,"events":[{"feedID":1,"sourceID":"T1","reason":"Review requested","repository":"opzero1/open-dot","title":"Fix <it>","url":null,"updatedAt":0}],"delivery":"admitted"},
       "baselined":2,"skippedCount":1,"skipped":[{"at":0,"reason":"Only 5 events go in one wake.","event":{"feedID":2,"sourceID":"T2","reason":"Review requested","repository":"opzero1/open-dot","title":"Other","url":null,"updatedAt":0}}]}
      """
    let trigger = try JSONDecoder().decode(FeedTrigger.self, from: Data(json.utf8))
    let text = triggerConfirmation(trigger, dot: "jojo", goal: "Reviews")
    XCTAssertTrue(text.contains("opzero1/open-dot for Review requested"))
    XCTAssertTrue(text.contains("ses_jojo about responsibility #3 (Reviews)"))
    XCTAssertTrue(text.contains("\n\nReview it.\nThen tell me.\n\n"))
    XCTAssertTrue(text.contains("Revision aaaaaaaaaaaa."))
    let summary = triggerSummary(trigger, now: Date(timeIntervalSince1970: 30))
    XCTAssertEqual(summary, "Last wake just now, 1 event, OpenCode has it · 1 skipped · 2 recorded without waking · bound to ses_jojo")
  }
}
