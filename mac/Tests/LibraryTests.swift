import AppKit
import CryptoKit
import XCTest
@testable import open_dot_notch

/// The Library tab: its menu item, its pages, and exports through a stand-in save panel, with no
/// daemon, window or real panel.
final class LibraryTests: XCTestCase {
  @MainActor func testLibraryIsTheMenusThirdItemAndOnlyReadsTheLibrary() async throws {
    let store = try isolatedStore()
    var reads: [String] = []
    store.libraryPage = { dot, before in
      reads.append("\(dot) \(before.map(String.init) ?? "latest")")
      return ArtifactPage(artifacts: [artifact(1, "report.md")])
    }
    store.artifactBytes = { _, _ in XCTFail("Opening the Library downloads nothing"); return Data() }
    store.chooseExport = { _ in XCTFail("Opening the Library shows no save panel"); return nil }

    let menu = dotMenu(store, dot: "jolyne")
    XCTAssertEqual(menu.items.map { $0.identifier?.rawValue }, ["dot-menu-memory", "dot-menu-instructions", "dot-menu-library", "dot-menu-health"])
    let item = try XCTUnwrap(menu.items.first { $0.identifier?.rawValue == "dot-menu-library" })
    XCTAssertTrue(NSApplication.shared.sendAction(try XCTUnwrap(item.action), to: item.target, from: item))
    await eventually { store.selected == "jolyne" && store.pane == .library && store.libraries["jolyne"]?.rows.count == 1 }
    XCTAssertEqual(reads, ["jolyne latest"])
    XCTAssertFalse(store.showingMemory)
    XCTAssertFalse(store.showingInstructions)

    store.show(.chat)
    XCTAssertEqual(store.pane, .chat)
    XCTAssertEqual(store.selected, "jolyne")
  }

  @MainActor func testOlderPagesLoadOnceAndAFailureSaysSo() async throws {
    let store = try isolatedStore()
    let newest = (3...52).reversed().map { artifact($0, "r\($0).txt") }
    store.libraryPage = { _, before in
      before == nil ? ArtifactPage(artifacts: newest, next: 3) : ArtifactPage(artifacts: [artifact(2, "r2.txt"), artifact(1, "r1.txt")])
    }
    await store.refreshLibrary("jojo")
    XCTAssertEqual(store.libraries["jojo"]?.older, 3)
    store.loadOlderLibrary("jojo")
    await eventually { store.libraries["jojo"]?.rows.count == 52 }
    XCTAssertEqual(store.libraries["jojo"]?.rows.first?.id, 52)
    XCTAssertEqual(store.libraries["jojo"]?.rows.last?.id, 1)
    XCTAssertNil(store.libraries["jojo"]?.older)

    store.libraryPage = { _, _ in throw APIError.server("Not running") }
    await store.refreshLibrary("jojo")
    XCTAssertEqual(store.libraries["jojo"]?.error, "Couldn't read the Library. Not running")
    XCTAssertEqual(store.libraries["jojo"]?.rows.count, 52, "What's shown stays")
  }

  @MainActor func testExportWritesExactlyTheListedBytesWhereChosen() async throws {
    let store = try isolatedStore()
    let bytes = Data("# Findings\n<script>alert(1)</script>\n".utf8)
    let report = artifact(7, "Q3: report.md", bytes: bytes)
    let folder = FileManager.default.temporaryDirectory.appending(path: "open-dot-export-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    var offered: [String] = []
    store.artifactBytes = { dot, id in
      XCTAssertEqual(dot, "jojo")
      XCTAssertEqual(id, 7)
      return bytes
    }
    store.chooseExport = { name in
      offered.append(name)
      return folder.appending(path: "saved.md")
    }

    store.exportArtifact("jojo", report)
    await eventually { !store.exportingArtifacts.contains(7) }
    XCTAssertEqual(offered, ["Q3_ report.md"])
    XCTAssertEqual(try Data(contentsOf: folder.appending(path: "saved.md")), bytes)
    XCTAssertEqual(store.libraryNotices[7], "Exported to \(folder.appending(path: "saved.md").path).")

    // Bytes that aren't the listed digest are never saved, and the panel never shows.
    store.artifactBytes = { _, _ in Data("# Findings\n<script>alert(2)</script>\n".utf8) }
    store.chooseExport = { _ in XCTFail("No panel for unmatched bytes"); return nil }
    store.exportArtifact("jojo", artifact(8, "other.md", bytes: bytes))
    await eventually { !store.exportingArtifacts.contains(8) }
    XCTAssertEqual(store.libraryNotices[8], "Not exported: the bytes didn't match the Library's SHA-256.")

    // Cancelling the panel writes nothing and says nothing.
    store.artifactBytes = { _, _ in bytes }
    store.chooseExport = { _ in nil }
    store.exportArtifact("jojo", artifact(9, "cancel.md", bytes: bytes))
    await eventually { !store.exportingArtifacts.contains(9) }
    XCTAssertNil(store.libraryNotices[9])
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.path), ["saved.md"])

    // A refusal from the daemon shows, and a missing or corrupt one isn't even read.
    store.artifactBytes = { _, _ in throw APIError.server("This deliverable's copy is missing.") }
    store.exportArtifact("jojo", artifact(10, "gone.md", bytes: bytes))
    await eventually { store.libraryNotices[10] != nil }
    XCTAssertEqual(store.libraryNotices[10], "Not exported. This deliverable's copy is missing. No automatic retry.")
    store.artifactBytes = { _, _ in XCTFail("Not read"); return bytes }
    store.exportArtifact("jojo", artifact(11, "bad.md", bytes: bytes, status: "corrupt"))
    XCTAssertFalse(store.exportingArtifacts.contains(11))
  }

  func testExportNamesAndStatusesAreSafeAndHonest() {
    XCTAssertEqual(exportFilename(artifact(1, "../evil:name\n.md")), "_evil_name_.md")
    XCTAssertEqual(exportFilename(artifact(2, "...")), "deliverable-2")
    XCTAssertEqual(exportFilename(artifact(3, "résumé.pdf")), "résumé.pdf")
    XCTAssertNil(artifact(1, "a.md").statusText)
    XCTAssertTrue(artifact(1, "a.md", status: "missing").statusText?.hasPrefix("Missing") == true)
    XCTAssertTrue(artifact(1, "a.md", status: "corrupt").statusText?.hasPrefix("Corrupt") == true)
    XCTAssertTrue(matchesArtifact(Data("x".utf8), artifact(1, "a.md", bytes: Data("x".utf8))))
    XCTAssertFalse(matchesArtifact(Data("y".utf8), artifact(1, "a.md", bytes: Data("x".utf8))))
  }
}

private struct NotIsolated: Error {}

private func artifact(_ id: Int, _ name: String, bytes: Data = Data("x".utf8), status: String = "present") -> Artifact {
  Artifact(
    id: id, name: name, mime: "text/markdown", size: bytes.count,
    sha256: SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined(),
    createdAt: 0, worker: 1, sessionID: "ses_w1", path: name, status: status)
}

/// A store with two dots shown, whose daemon client reads `api.json` from an empty temporary
/// directory, so nothing ever reaches a real daemon.
@MainActor private func isolatedStore() throws -> Store {
  let previous = getenv("OPEN_DOT_HOME").map { String(cString: $0) }
  let home = FileManager.default.temporaryDirectory.appending(path: "open-dot-tests-\(UUID().uuidString)").path
  setenv("OPEN_DOT_HOME", home, 1)
  defer {
    if let previous { setenv("OPEN_DOT_HOME", previous, 1) } else { unsetenv("OPEN_DOT_HOME") }
  }
  guard ProcessInfo.processInfo.environment["OPEN_DOT_HOME"] == home else { throw NotIsolated() }
  let store = Store()
  store.latestPage = { _ in throw APIError.unreachable }
  store.dots = ["jojo", "jolyne"].map { Dot(name: $0, purpose: nil, busy: false, workers: []) }
  store.loaded = true
  store.expanded = true
  store.selected = "jojo"
  return store
}

@MainActor private func eventually(within limit: Duration = .seconds(3), _ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
  let end = ContinuousClock.now + limit
  while !condition() && ContinuousClock.now < end { try? await Task.sleep(for: .milliseconds(10)) }
  XCTAssertTrue(condition(), "Timed out", file: file, line: line)
}
