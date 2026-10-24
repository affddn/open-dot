import SwiftUI

/// What a deliverable row says under its name: its type, size, worker and age.
func artifactLine(_ artifact: Artifact, now: Date = Date()) -> String {
  let size = ByteCountFormatter.string(fromByteCount: Int64(artifact.size), countStyle: .file)
  return "\(artifact.kind) · \(size) · worker #\(artifact.worker) · added \(ago(artifact.createdAt, now: now))"
}

/// A dot's Library: the deliverables it added from its workers, newest first. Read-only: nothing
/// here starts a turn, and Export… only saves a copy where the owner chooses, never opening it.
struct LibraryView: View {
  let store: Store
  let name: String

  var body: some View {
    let state = store.libraries[name]
    ScrollView {
      VStack(alignment: .leading, spacing: 8) {
        if let error = state?.error {
          Text(error).font(.caption2).foregroundStyle(.red).accessibilityIdentifier("library-error")
        }
        if let state {
          let rows = state.rows
          if rows.isEmpty && state.error == nil {
            Text("No deliverables yet. A dot adds one from its workers with dot_library_add.")
              .font(.caption).foregroundStyle(.tertiary)
          }
          ForEach(rows) { LibraryRow(store: store, dot: name, artifact: $0) }
          if state.older != nil {
            Button(state.loadingOlder ? "Loading…" : "Load older") { store.loadOlderLibrary(name) }
              .buttonStyle(.plain)
              .font(.caption2.weight(.semibold))
              .disabled(state.loadingOlder)
              .accessibilityIdentifier("library-older")
          }
        } else {
          Text("Loading…").foregroundStyle(.secondary)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .scrollIndicators(.never)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("library-\(name)")
  }
}

struct LibraryRow: View {
  let store: Store
  let dot: String
  let artifact: Artifact

  var body: some View {
    let busy = store.exportingArtifacts.contains(artifact.id)
    VStack(alignment: .leading, spacing: 3) {
      HStack(alignment: .firstTextBaseline) {
        Text(verbatim: artifact.name).font(.caption.weight(.medium)).lineLimit(2).textSelection(.enabled)
        Spacer()
        Button(busy ? "Exporting…" : "Export…") { store.exportArtifact(dot, artifact) }
          .buttonStyle(.plain)
          .font(.caption2.weight(.semibold))
          .disabled(busy || !artifact.available)
          .opacity(artifact.available ? 1 : 0.4)
          .help("Save a copy where you choose. It isn't opened.")
          .accessibilityIdentifier("library-export-\(artifact.id)")
      }
      Text(verbatim: artifactLine(artifact)).font(.caption2).foregroundStyle(.secondary)
      if let status = artifact.statusText {
        Text(verbatim: status).font(.caption2).foregroundStyle(.orange)
          .accessibilityIdentifier("library-status-\(artifact.id)")
      }
      if let notice = store.libraryNotices[artifact.id] {
        Text(verbatim: notice).font(.caption2).foregroundStyle(.secondary).textSelection(.enabled)
          .accessibilityIdentifier("library-notice-\(artifact.id)")
      }
      DisclosureGroup("Details") {
        VStack(alignment: .leading, spacing: 2) {
          Text(verbatim: "Saved as \(artifact.path) in worker #\(artifact.worker)'s output directory")
          Text(verbatim: "Session \(artifact.sessionID)")
          Text(verbatim: "SHA-256 \(artifact.sha256)")
        }
        .font(.caption2.monospaced())
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .font(.caption2)
    }
    .padding(8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 10).fill(.white.opacity(0.05)))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("library-row-\(artifact.id)")
  }
}
