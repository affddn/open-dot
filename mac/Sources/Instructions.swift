import AppKit
import SwiftUI

/// The most UTF-8 bytes of AGENTS.md the daemon saves.
let instructionsLimit = 64 * 1024

/// When an edit takes effect, from OpenCode 2.1.1's instruction plugin: it watches the file,
/// reloads 100 ms after a change, and the next model request uses the reloaded text.
let instructionsTiming = "OpenCode watches this file. After it reloads (normally shortly after saving), edits apply to the next model request, including during a running turn. No restart is needed."

/// One dot's AGENTS.md editor. The draft lives in the store, so it survives the notch folding
/// away and switching dots or views; nothing discards it without asking. One request runs at a
/// time, and only `edit` changes the draft, never while a request runs, so an answer always
/// matches what was sent. Nothing here retries on its own.
struct InstructionsState: Equatable {
  enum Busy: Equatable {
    case loading
    case saving(String)
    case reverting
  }

  /// The file the draft started from. Its revision goes with Save and Revert.
  private(set) var base: Instructions?
  /// The editor's text. Only `edit` and the request transitions change it.
  private(set) var draft = ""
  private(set) var busy: Busy?
  /// The file as it is on disk after a 409, until the owner reloads or overwrites. `fromRevert`
  /// is a refused revert, which has nothing to overwrite with.
  private(set) var conflict: Instructions?
  private(set) var conflictFromRevert = false
  /// Why the last request failed, or that its outcome is unknown. Cleared by the next request.
  var error: String?
  /// What the last request did, such as "Saved."
  var notice: String?

  var dirty: Bool { base.map { draft != $0.content } ?? false }
  var bytes: Int { draft.utf8.count }
  var tooLarge: Bool { bytes > instructionsLimit }
  var canSave: Bool { base != nil && busy == nil && conflict == nil && dirty && !tooLarge }
  var canRevert: Bool { base?.canRevert == true && busy == nil && conflict == nil }
  /// Overwrite saves the draft at the revision the conflict reported, never without one.
  var canOverwrite: Bool { conflict != nil && !conflictFromRevert && busy == nil && !tooLarge }

  /// The owner's typing, kept only once a file is loaded and while no request runs. False when
  /// refused, so the editor goes back to the draft.
  @discardableResult mutating func edit(_ text: String) -> Bool {
    guard base != nil, busy == nil else { return false }
    draft = text
    return true
  }

  /// A read, unless one is already running, or, when not `discarding`, the draft has edits.
  mutating func beginRead(discarding: Bool) -> Bool {
    guard busy == nil, discarding || !dirty else { return false }
    busy = .loading
    error = nil
    notice = nil
    return true
  }

  mutating func finishRead(_ result: Result<Instructions, MemoryInvalid>) {
    busy = nil
    switch result {
    case .success(let read):
      base = read
      draft = read.content
      conflict = nil
      conflictFromRevert = false
    case .failure(let failure):
      error = failure.message
    }
  }

  /// What to send, or nil when nothing should be: the draft and the revision it replaces, which
  /// is the conflict's revision for Overwrite.
  mutating func beginSave(overwrite: Bool) -> (content: String, revision: String)? {
    guard let base, busy == nil else { return nil }
    if draft.contains("\0") {
      error = "Instructions can't contain NUL characters."
      return nil
    }
    if tooLarge {
      error = "Instructions must be at most 64 KiB of UTF-8 text."
      return nil
    }
    let revision: String
    if overwrite {
      guard canOverwrite, let conflict else { return nil }
      revision = conflict.revision
    } else {
      guard conflict == nil, dirty else { return nil }
      revision = base.revision
    }
    busy = .saving(draft)
    error = nil
    notice = nil
    return (draft, revision)
  }

  mutating func beginRevert() -> String? {
    guard canRevert, let base else { return nil }
    busy = .reverting
    error = nil
    notice = nil
    return base.revision
  }

  enum Settled {
    case outcome(InstructionsOutcome)
    /// A refusal, or no answer; the message says which. The draft stays for a manual retry, which
    /// the revision check refuses if the first one landed.
    case failed(String)
  }

  mutating func finish(_ settled: Settled) {
    let request = busy
    busy = nil
    switch settled {
    case .failed(let message):
      error = message
    case .outcome(.saved(let file)):
      base = file
      draft = file.content
      conflict = nil
      conflictFromRevert = false
      notice = request == .reverting ? "Reverted to the previous version." : "Saved."
    case .outcome(.conflict(let current, let message)):
      if case .saving(let sent) = request, current.content == sent {
        // An earlier save whose answer was lost had landed.
        base = current
        conflict = nil
        conflictFromRevert = false
        notice = "The file already has your text."
      } else {
        conflict = current
        conflictFromRevert = request == .reverting
        error = message
      }
    }
  }

  /// Cancel: the draft goes back to the file it started from.
  mutating func discard() {
    guard busy == nil, let base else { return }
    draft = base.content
    error = nil
  }
}

/// A plain monospaced editor with its own undo history, which ends with it, like the composer's.
/// Each change goes through `edit`; one it refuses, such as typing or an undo that reached the
/// view while a request runs, is put back to `text`, the draft as last shown.
struct InstructionsEditor: NSViewRepresentable {
  let text: String
  let editable: Bool
  let edit: @MainActor (String) -> Bool

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  func makeNSView(context: Context) -> NSScrollView {
    let scroll = NSScrollView()
    scroll.drawsBackground = false
    scroll.hasVerticalScroller = true
    let editor = PlainTextView()
    editor.isRichText = false
    editor.allowsUndo = true
    editor.drawsBackground = false
    editor.textColor = .white
    editor.insertionPointColor = .white
    editor.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
    // Markdown is code-like: no curly quotes, dashes, replaced text or spelling fixes.
    editor.isAutomaticQuoteSubstitutionEnabled = false
    editor.isAutomaticDashSubstitutionEnabled = false
    editor.isAutomaticTextReplacementEnabled = false
    editor.isAutomaticSpellingCorrectionEnabled = false
    editor.isContinuousSpellCheckingEnabled = false
    editor.textContainerInset = NSSize(width: 4, height: 6)
    editor.isVerticallyResizable = true
    editor.autoresizingMask = [.width]
    editor.textContainer?.widthTracksTextView = true
    editor.delegate = context.coordinator
    editor.setAccessibilityLabel("Instructions")
    editor.setAccessibilityIdentifier("instructions-editor")
    scroll.documentView = editor
    return scroll
  }

  func updateNSView(_ scroll: NSScrollView, context: Context) {
    context.coordinator.parent = self
    guard let editor = scroll.documentView as? PlainTextView else { return }
    editor.isEditable = editable
    if editor.string != text {
      // Replaced from outside, as after a reload or revert, so earlier undo steps no longer fit.
      editor.history.removeAllActions()
      editor.string = text
    }
  }

  final class Coordinator: NSObject, NSTextViewDelegate {
    var parent: InstructionsEditor
    init(_ parent: InstructionsEditor) { self.parent = parent }
    func textDidChange(_ notification: Notification) {
      guard let editor = notification.object as? PlainTextView else { return }
      if parent.edit(editor.string) { return }
      // Its undo steps now describe a change that never reached the draft.
      editor.history.removeAllActions()
      editor.string = parent.text
    }
  }
}

/// Undo and redo change the text directly, past `isEditable`, so both check it themselves: while
/// a request runs they're disabled and do nothing.
final class PlainTextView: NSTextView {
  let history = UndoManager()
  override var undoManager: UndoManager? { history }
  @objc func undo(_ sender: Any?) { if isEditable { history.undo() } }
  @objc func redo(_ sender: Any?) { if isEditable { history.redo() } }

  override func validateMenuItem(_ item: NSMenuItem) -> Bool {
    return switch item.action {
    case #selector(undo(_:)): isEditable && history.canUndo
    case #selector(redo(_:)): isEditable && history.canRedo
    default: super.validateMenuItem(item)
    }
  }
}

/// The selected dot's AGENTS.md: a monospaced editor with Save and Cancel, Revert to the previous
/// version, and, after a conflict, Reload or Overwrite. Saving starts no turn.
struct InstructionsView: View {
  let store: Store
  let name: String

  var body: some View {
    let state = store.instructions[name] ?? InstructionsState()
    VStack(alignment: .leading, spacing: 6) {
      if let conflict = state.conflict { conflictBanner(state, conflict) }
      if let error = state.error, state.conflict == nil {
        Text(verbatim: error).font(.caption2).foregroundStyle(.red).textSelection(.enabled)
          .accessibilityIdentifier("instructions-error")
      }
      if state.base == nil {
        if state.busy == .loading {
          Text("Loading…").foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
          Button("Try Again") { store.loadInstructions(name, discarding: false) }
            .buttonStyle(.plain).font(.caption.weight(.semibold))
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityIdentifier("instructions-retry")
        }
      } else {
        InstructionsEditor(
          text: state.draft,
          editable: state.busy == nil,
          edit: { store.instructions[name]?.edit($0) ?? false }
        )
        .id("instructions-\(name)")
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(RoundedRectangle(cornerRadius: 10).fill(.white.opacity(0.06)))
        controls(state)
      }
      Text(instructionsTiming).font(.caption2).foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("instructions-timing")
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("instructions-\(name)")
  }

  private func controls(_ state: InstructionsState) -> some View {
    HStack(spacing: 10) {
      if state.tooLarge {
        Text("Over 64 KiB; shorten it to save.").foregroundStyle(.red)
      } else if let busy = state.busy {
        Text(busy == .loading ? "Loading…" : busy == .reverting ? "Reverting…" : "Saving…").foregroundStyle(.secondary)
      } else if state.dirty {
        Text("Unsaved changes").foregroundStyle(.orange)
      } else if let notice = state.notice {
        Text(verbatim: notice).foregroundStyle(.secondary)
      }
      Spacer()
      if state.base?.canRevert == true {
        Button("Revert…") { confirmRevert(state) }
          .disabled(!state.canRevert)
          .help("Put back the version before the last save")
          .accessibilityIdentifier("instructions-revert")
      }
      Button("Cancel") { confirmDiscard() }
        .disabled(!state.dirty || state.busy != nil)
        .accessibilityIdentifier("instructions-cancel")
      Button("Save") { store.saveInstructions(name, overwrite: false) }
        .disabled(!state.canSave)
        .accessibilityIdentifier("instructions-save")
    }
    .buttonStyle(.plain)
    .font(.caption.weight(.semibold))
  }

  private func conflictBanner(_ state: InstructionsState, _ conflict: Instructions) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(state.conflictFromRevert
        ? "AGENTS.md changed since you loaded it, so nothing was reverted."
        : "AGENTS.md changed since you loaded it, so nothing was saved. Your text is still in the editor.")
        .font(.caption.weight(.semibold)).foregroundStyle(.orange)
      DisclosureGroup("The file as it is now") {
        ScrollView {
          Text(verbatim: conflict.content.isEmpty ? "(empty)" : conflict.content)
            .font(.caption2.monospaced()).textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: 90)
      }
      .font(.caption2)
      HStack(spacing: 10) {
        Spacer()
        Button("Reload") { confirmReload(state) }
          .disabled(state.busy != nil)
          .help("Drop your edits and load the file as it is now")
          .accessibilityIdentifier("instructions-reload")
        if !state.conflictFromRevert {
          Button("Overwrite") { store.saveInstructions(name, overwrite: true) }
            .disabled(!state.canOverwrite)
            .help("Save your text over it. Its current text is kept as an earlier version for Revert.")
            .accessibilityIdentifier("instructions-overwrite")
        }
      }
      .buttonStyle(.plain)
      .font(.caption.weight(.semibold))
    }
    .padding(8)
    .background(RoundedRectangle(cornerRadius: 10).fill(.orange.opacity(0.12)))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("instructions-conflict")
  }

  /// Cancel asks first, with Keep Editing as the default for Return and Escape.
  private func confirmDiscard() {
    let alert = NSAlert()
    alert.messageText = "Discard your changes to \(name)'s instructions?"
    alert.informativeText = "The editor goes back to the text you loaded. AGENTS.md isn't changed."
    alert.addButton(withTitle: "Keep Editing")
    alert.addButton(withTitle: "Discard").hasDestructiveAction = true
    guard runAlert(alert, store) == .alertSecondButtonReturn else { return }
    store.instructions[name]?.discard()
  }

  private func confirmReload(_ state: InstructionsState) {
    if state.dirty {
      let alert = NSAlert()
      alert.messageText = "Discard your changes and reload?"
      alert.informativeText = "The editor shows AGENTS.md as it is on disk now. Your unsaved text is lost."
      alert.addButton(withTitle: "Keep Editing")
      alert.addButton(withTitle: "Reload").hasDestructiveAction = true
      guard runAlert(alert, store) == .alertSecondButtonReturn else { return }
    }
    store.loadInstructions(name, discarding: true)
  }

  private func confirmRevert(_ state: InstructionsState) {
    let alert = NSAlert()
    alert.messageText = "Revert \(name)'s instructions to the previous version?"
    alert.informativeText = "AGENTS.md gets the text it had before the last save, and that version leaves the history. The text it has now isn't kept\(state.dirty ? ", and your unsaved changes are lost" : ""). \(instructionsTiming)"
    alert.addButton(withTitle: "Cancel")
    alert.addButton(withTitle: "Revert").hasDestructiveAction = true
    guard runAlert(alert, store) == .alertSecondButtonReturn else { return }
    store.revertInstructions(name)
  }
}
