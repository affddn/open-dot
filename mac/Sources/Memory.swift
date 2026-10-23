import AppKit
import SwiftUI

/// The longest note, goal or next action the daemon accepts, and the longest repeat, in minutes.
let memoryTextLimit = 2000
let maxEveryMinutes = 365 * 24 * 60

/// An edit in progress: the item as it was when the owner started, which fixes the version sent,
/// and the values being edited. It lives in the store, so it survives the panel folding away.
struct MemoryDraft: Equatable {
  let base: MemoryItem
  var text = ""
  var goal = ""
  var nextAction = ""
  var status = "active"
  var due = Date()
  var repeats = false
  var every = 60

  init(_ item: MemoryItem) {
    base = item
    switch item {
    case .note(let note): text = note.text
    case .responsibility(let item):
      goal = item.goal
      nextAction = item.nextAction
      status = item.status
    case .reminder(let reminder):
      due = Date(timeIntervalSince1970: reminder.dueAt / 1000)
      repeats = reminder.everyMinutes != nil
      every = reminder.everyMinutes ?? 60
    }
  }

  var version: Int {
    switch base {
    case .note(let note): note.version
    case .responsibility(let item): item.version
    case .reminder(let reminder): reminder.version
    }
  }

  var summary: String {
    switch base {
    case .note: text
    case .responsibility: "\(goal)\nNext: \(nextAction)\nStatus: \(status)"
    case .reminder: "\(due.formatted()), \(repeats ? "every \(every) minutes" : "one-off")"
    }
  }

  /// What to send: only the fields changed from `base`, or nil when nothing changed. Throws a
  /// message for a value the daemon would refuse, so nothing is sent.
  func changes(now: Date = Date()) throws -> [String: Any]? {
    func checked(_ value: String, _ name: String) throws -> String {
      let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
      if trimmed.isEmpty { throw MemoryInvalid("\(name) can't be blank.") }
      if trimmed.utf16.count > memoryTextLimit { throw MemoryInvalid("\(name) must be at most \(memoryTextLimit) characters.") }
      return trimmed
    }
    var fields: [String: Any] = [:]
    switch base {
    case .note(let note):
      let text = try checked(self.text, "A note")
      if text != note.text { fields["text"] = text }
    case .responsibility(let item):
      let goal = try checked(self.goal, "The goal")
      let next = try checked(self.nextAction, "The next action")
      if goal != item.goal { fields["goal"] = goal }
      if next != item.nextAction { fields["nextAction"] = next }
      if status != item.status { fields["status"] = status }
    case .reminder(let reminder):
      let dueAt = (due.timeIntervalSince1970 * 1000).rounded()
      if dueAt != reminder.dueAt {
        if due <= now { throw MemoryInvalid("Pick a time in the future.") }
        fields["dueAt"] = Int64(dueAt)
      }
      let interval = repeats ? every : nil
      if let interval, !(1...maxEveryMinutes).contains(interval) {
        throw MemoryInvalid("Repeat every 1 to \(maxEveryMinutes) minutes.")
      }
      if interval != reminder.everyMinutes { fields["everyMinutes"] = interval.map { $0 as Any } ?? NSNull() }
    }
    return fields.isEmpty ? nil : fields
  }
}

struct MemoryInvalid: Error, Equatable {
  let message: String
  init(_ message: String) { self.message = message }
}

/// One dot's memory as shown, with the owner's changes laid over the daemon's reads. A read begun
/// before or during a change is dropped, so it can't bring back what the change replaced. Nothing
/// here retries a change: a conflict shows the current value, and a lost answer says so.
struct MemoryState {
  private(set) var memory: Memory?
  /// Why the last read failed, until a read succeeds.
  var readError: String?
  /// Why the last add, or a change to an item no longer shown, failed. Cleared by the owner.
  var notice: String?
  var errors: [MemoryKey: String] = [:]
  var drafts: [MemoryKey: MemoryDraft] = [:]
  var rejected: [MemoryKey: MemoryDraft] = [:]
  var noteDraft = ""
  /// Supervisions being approved or ended.
  var supervising: Set<Int> = []
  private(set) var saving: Set<MemoryKey> = []
  private(set) var adding = false
  private var writes = 0
  private var reads = 0

  struct Read {
    fileprivate let number: Int
    fileprivate let writes: Int
  }

  enum Settled {
    case outcome(MemoryOutcome)
    /// No answer, or a refusal. The message says which; the draft stays for a manual retry.
    case failed(String)
  }

  mutating func startRead() -> Read {
    reads += 1
    return Read(number: reads, writes: writes)
  }

  func isCurrent(_ read: Read) -> Bool { read.number == reads }

  /// Shows a read, unless a newer read began or any change began or ended since it did.
  mutating func apply(_ read: Read, _ memory: Memory) -> Bool {
    guard isCurrent(read), read.writes == writes, saving.isEmpty, !adding else { return false }
    self.memory = memory
    readError = nil
    return true
  }

  mutating func edit(_ item: MemoryItem) {
    errors[item.key] = nil
    drafts[item.key] = MemoryDraft(item)
  }

  /// Marks the item as saving. False if it already is, so a second click sends nothing.
  mutating func begin(_ key: MemoryKey) -> Bool {
    guard saving.insert(key).inserted else { return false }
    writes += 1
    errors[key] = nil
    return true
  }

  mutating func finish(_ key: MemoryKey, _ settled: Settled) {
    writes += 1
    saving.remove(key)
    switch settled {
    case .failed(let message):
      errors[key] = message
    case .outcome(.saved(let item)):
      drafts[key] = nil
      rejected[key] = nil
      put(item)
    case .outcome(.deleted):
      drafts[key] = nil
      remove(key)
    case .outcome(.conflict(let item, _)):
      rejected[key] = drafts[key]
      drafts[key] = nil
      if case .reminder(let reminder) = item, reminder.state != "scheduled" {
        remove(key)
        notice = "Nothing was changed: that reminder already went off."
      } else {
        put(item)
        errors[key] = "Not done: this was changed since you loaded it, so this is its current value. Nothing was retried."
      }
    case .outcome(.gone):
      drafts[key] = nil
      remove(key)
      notice = "Nothing was changed: that item is gone, maybe deleted by the dot."
    }
  }

  mutating func beginAdd() -> Bool {
    guard !adding else { return false }
    adding = true
    writes += 1
    notice = nil
    return true
  }

  mutating func finishAdd(_ result: Result<MemoryNote, MemoryInvalid>) {
    writes += 1
    adding = false
    switch result {
    case .success(let note): put(.note(note))
    case .failure(let failure): notice = failure.message
    }
  }

  private mutating func put(_ item: MemoryItem) {
    guard var memory else { return }
    switch item {
    case .note(let note):
      if let index = memory.notes.firstIndex(where: { $0.id == note.id }) { memory.notes[index] = note } else { memory.notes.append(note) }
    case .responsibility(let item):
      if let index = memory.responsibilities.firstIndex(where: { $0.id == item.id }) { memory.responsibilities[index] = item } else { memory.responsibilities.append(item) }
    case .reminder(let reminder):
      if let index = memory.reminders.firstIndex(where: { $0.id == reminder.id }) { memory.reminders[index] = reminder } else { memory.reminders.append(reminder) }
    }
    self.memory = memory
  }

  private mutating func remove(_ key: MemoryKey) {
    errors[key] = nil
    switch key.kind {
    case .note: memory?.notes.removeAll { $0.id == key.id }
    case .responsibility: memory?.responsibilities.removeAll { $0.id == key.id }
    case .reminder: memory?.reminders.removeAll { $0.id == key.id }
    }
  }
}

/// "just now", "5m ago", "2h ago" or "3d ago", for a time in milliseconds.
func ago(_ time: Double, now: Date = Date()) -> String {
  let seconds = max(0, now.timeIntervalSince1970 - time / 1000)
  return seconds < 60 ? "just now"
    : seconds < 3600 ? "\(Int(seconds / 60))m ago"
    : seconds < 86400 ? "\(Int(seconds / 3600))h ago"
    : "\(Int(seconds / 86400))d ago"
}

/// "Updated 5m ago by jojo", "by you" or "by its schedule".
func memoryChange(_ updatedAt: Double, by actor: String, dot: String, now: Date = Date()) -> String {
  let who = actor == "owner" ? "you" : actor == "scheduler" ? "its schedule" : actor == "dot" ? dot : actor
  return "Updated \(ago(updatedAt, now: now)) by \(who)"
}

/// When a supervision was asked for or created, and when the owner made it active if that was later.
func supervisionTimes(_ binding: Supervision, now: Date = Date()) -> String {
  guard binding.state == "active" else { return "Requested \(ago(binding.createdAt, now: now))" }
  let created = "Created \(ago(binding.createdAt, now: now))"
  guard let activated = binding.activatedAt, activated != binding.createdAt else { return created }
  return "\(created), approved \(ago(activated, now: now))"
}

/// A dot's notes, responsibilities and reminders. Changes start no turn: the dot sees them in its
/// next memory snapshot.
struct MemoryView: View {
  let store: Store
  let name: String

  var body: some View {
    let state = store.memories[name]
    ScrollView {
      VStack(alignment: .leading, spacing: 12) {
        if let error = state?.readError {
          Text(error).font(.caption2).foregroundStyle(.red)
        }
        if let notice = state?.notice {
          Text("\(notice) · click to clear").font(.caption2).foregroundStyle(.red)
            .onTapGesture { store.memories[name]?.notice = nil }
            .accessibilityIdentifier("memory-notice")
        }
        if let memory = state?.memory {
          section("Notes") {
            ForEach(memory.notes) { MemoryRow(store: store, dot: name, item: .note($0)) }
            addNote
          }
          section("Responsibilities") {
            if memory.responsibilities.isEmpty { empty }
            ForEach(memory.responsibilities) { MemoryRow(store: store, dot: name, item: .responsibility($0)) }
          }
          section("Scheduled reminders") {
            if memory.reminders.isEmpty { empty }
            ForEach(memory.reminders) { MemoryRow(store: store, dot: name, item: .reminder($0)) }
          }
          section("Supervised sessions") {
            let bindings = memory.supervisions ?? []
            if bindings.isEmpty { empty }
            ForEach(bindings) { SupervisionRow(store: store, dot: name, binding: $0) }
          }
          if let audit = store.requestAudits[name] {
            section("Worker requests and answers") {
              let rows = audit.rows
              if rows.isEmpty { empty }
              ForEach(rows) { RequestAuditRow(request: $0) }
              if audit.older != nil {
                Button(audit.loadingOlder ? "Loading…" : "Load older") { store.loadOlderAudit(name) }
                  .buttonStyle(.plain)
                  .font(.caption2.weight(.semibold))
                  .disabled(audit.loadingOlder)
                  .accessibilityIdentifier("request-audit-older")
              }
            }
          }
        } else if state?.readError == nil {
          Text("Loading…").foregroundStyle(.secondary)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .scrollIndicators(.never)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("memory-\(name)")
  }

  private var empty: some View { Text("None").font(.caption).foregroundStyle(.tertiary) }

  private func section<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
      content()
    }
  }

  private var addNote: some View {
    let draft = Binding { store.memories[name]?.noteDraft ?? "" } set: { store.memories[name, default: MemoryState()].noteDraft = $0 }
    let adding = store.memories[name]?.adding == true
    let blank = draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    return HStack {
      TextField("Add a note", text: draft, axis: .vertical)
        .textFieldStyle(.plain)
        .lineLimit(1...4)
        .accessibilityIdentifier("memory-note-draft")
      Button(adding ? "Adding…" : "Add") { store.addNote(name) }
        .buttonStyle(.plain)
        .font(.caption.weight(.semibold))
        .disabled(adding || blank)
        .opacity(adding || blank ? 0.4 : 1)
        .accessibilityIdentifier("memory-note-add")
    }
    .padding(8)
    .background(RoundedRectangle(cornerRadius: 10).fill(.white.opacity(0.05)))
  }
}

struct MemoryRow: View {
  let store: Store
  let dot: String
  let item: MemoryItem

  var body: some View {
    let key = item.key
    let state = store.memories[dot]
    let saving = state?.saving.contains(key) == true
    VStack(alignment: .leading, spacing: 4) {
      if state?.drafts[key] != nil {
        editor(key, saving: saving)
          .disabled(saving)
      } else {
        content
        HStack(spacing: 10) {
          Text(meta).font(.caption2).foregroundStyle(.tertiary)
          Spacer()
          if saving {
            Text("Saving…").font(.caption2).foregroundStyle(.secondary)
          } else {
            Button(editTitle) { store.memories[dot]?.edit(item) }
              .accessibilityIdentifier("memory-edit-\(key.kind.rawValue)-\(key.id)")
            if let removal = removalTitle {
              Button(removal) { confirmRemoval(key) }
                .accessibilityIdentifier("memory-remove-\(key.kind.rawValue)-\(key.id)")
            }
          }
        }
        .buttonStyle(.plain)
        .font(.caption2.weight(.semibold))
      }
      if let error = state?.errors[key] {
        Text("\(error) · click to clear").font(.caption2).foregroundStyle(.red)
          .onTapGesture { store.memories[dot]?.errors[key] = nil }
      }
      if let rejected = state?.rejected[key] {
        Text("Your rejected edit (not saved)").font(.caption.weight(.semibold))
        Text(verbatim: rejected.summary).font(.caption).textSelection(.enabled)
        Text("The current value is above. Choose Edit to start from it; your rejected text stays here to copy.")
          .font(.caption2).foregroundStyle(.secondary)
        Button("Discard rejected edit") { store.memories[dot]?.rejected[key] = nil }
          .buttonStyle(.plain).font(.caption2)
      }
    }
    .padding(8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 10).fill(.white.opacity(0.05)))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("memory-\(key.kind.rawValue)-\(key.id)")
  }

  @ViewBuilder private var content: some View {
    switch item {
    case .note(let note):
      Text(verbatim: note.text).font(.callout).textSelection(.enabled)
    case .responsibility(let responsibility):
      HStack(alignment: .firstTextBaseline) {
        Text(verbatim: responsibility.goal).font(.callout.weight(.medium))
        Spacer()
        if responsibility.status != "active" {
          Text(responsibility.status).font(.caption2).foregroundStyle(.secondary)
        }
      }
      Text(verbatim: "Next: \(responsibility.nextAction)").font(.caption).foregroundStyle(.secondary)
      if let schedule = responsibility.schedule {
        Text(verbatim: scheduleLine(schedule, responsibility)).font(.caption).foregroundStyle(.secondary)
      }
    case .reminder(let reminder):
      Text(verbatim: reminder.text).font(.callout)
      Text(verbatim: when(reminder)).font(.caption).foregroundStyle(.secondary)
    }
  }

  private var meta: String {
    switch item {
    case .note(let note): memoryChange(note.updatedAt, by: note.updatedBy, dot: dot)
    case .responsibility(let item): memoryChange(item.updatedAt, by: item.updatedBy, dot: dot)
    case .reminder(let reminder): memoryChange(reminder.updatedAt, by: reminder.updatedBy, dot: dot)
    }
  }

  private var editTitle: String {
    if case .reminder = item { return "Change" }
    return "Edit"
  }

  private var removalTitle: String? {
    switch item {
    case .note: "Delete…"
    case .reminder: "Cancel…"
    case .responsibility: nil
    }
  }

  private func scheduleLine(_ schedule: ResponsibilitySchedule, _ item: MemoryResponsibility) -> String {
    guard item.status == "active" else { return "\(schedule.summary), paused" }
    guard let next = item.nextRunAt else { return schedule.summary }
    let date = Date(timeIntervalSince1970: next / 1000).formatted(date: .abbreviated, time: .shortened)
    return "\(schedule.summary), next \(date)"
  }

  private func when(_ reminder: MemoryReminder) -> String {
    let date = Date(timeIntervalSince1970: reminder.dueAt / 1000).formatted(date: .abbreviated, time: .shortened)
    return reminder.everyMinutes.map { "\(date), then every \($0) min" } ?? date
  }

  @ViewBuilder private func editor(_ key: MemoryKey, saving: Bool) -> some View {
    let draft = Binding { store.memories[dot]?.drafts[key] ?? MemoryDraft(item) } set: { store.memories[dot]?.drafts[key] = $0 }
    switch item {
    case .note:
      TextField("Note", text: draft.text, axis: .vertical).lineLimit(1...6)
    case .responsibility:
      TextField("Goal", text: draft.goal, axis: .vertical).lineLimit(1...3)
      TextField("Next action", text: draft.nextAction, axis: .vertical).lineLimit(1...3)
      Picker("Status", selection: draft.status) {
        Text("Active").tag("active")
        Text("Done").tag("done")
        Text("Dropped").tag("dropped")
      }
      .pickerStyle(.segmented)
      .labelsHidden()
    case .reminder:
      // A stepper field, not a popover calendar, so the notch doesn't lose the pointer to another window.
      DatePicker("Time", selection: draft.due, in: Date()..., displayedComponents: [.date, .hourAndMinute])
        .datePickerStyle(.stepperField)
      HStack {
        Toggle("Repeat every", isOn: draft.repeats)
        TextField("Minutes", value: draft.every, format: .number).frame(width: 70).disabled(!draft.wrappedValue.repeats)
        Text("minutes").foregroundStyle(.secondary)
      }
      .font(.caption)
    }
    HStack {
      Spacer()
      if saving {
        Text("Saving…").foregroundStyle(.secondary)
      } else {
        Button("Cancel") { store.memories[dot]?.drafts[key] = nil }
        Button("Save") { store.saveMemory(dot, key) }
          .accessibilityIdentifier("memory-save-\(key.kind.rawValue)-\(key.id)")
      }
    }
    .buttonStyle(.plain)
    .font(.caption.weight(.semibold))
  }

  /// Asks first, with Cancel as the default for Return and Escape, then deletes the note or cancels
  /// the reminder at the version shown.
  private func confirmRemoval(_ key: MemoryKey) {
    let alert = NSAlert()
    switch item {
    case .note(let note):
      alert.messageText = "Delete this note?"
      alert.informativeText = "\(dot) won't see it in its memory any more: \(note.text.prefix(200))"
      alert.addButton(withTitle: "Cancel")
      alert.addButton(withTitle: "Delete").hasDestructiveAction = true
    case .reminder(let reminder):
      alert.messageText = "Cancel this reminder?"
      alert.informativeText = "It won't go off\(reminder.everyMinutes == nil ? "" : " again"): \(reminder.text.prefix(200))"
      alert.addButton(withTitle: "Keep It")
      alert.addButton(withTitle: "Cancel Reminder").hasDestructiveAction = true
    case .responsibility:
      return
    }
    guard runAlert(alert, store) == .alertSecondButtonReturn else { return }
    store.removeMemory(dot, item)
  }
}

/// One worker request as the owner reviews it: what was asked, which dot session answered, how, and
/// what OpenCode confirmed. What was asked is the worker's data.
struct RequestAuditRow: View {
  let request: RequestAudit

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(verbatim: request.line)
        .font(.caption.weight(.medium))
        .foregroundStyle(request.needsYou ? AnyShapeStyle(.orange) : AnyShapeStyle(.primary))
      Text(verbatim: request.asked).font(.caption).foregroundStyle(.secondary).textSelection(.enabled).lineLimit(3)
      if let reason = request.reason {
        Text(verbatim: reason).font(.caption2).foregroundStyle(.secondary).textSelection(.enabled)
      }
      Text(verbatim: requestTimes(request)).font(.caption2).foregroundStyle(.tertiary).textSelection(.enabled)
      DisclosureGroup("Details") {
        VStack(alignment: .leading, spacing: 4) {
          Text(verbatim: "OpenCode request \(request.requestID)").font(.caption2.monospaced()).textSelection(.enabled)
          Text("What was asked, as the worker's data:").font(.caption2).foregroundStyle(.secondary)
          Text(verbatim: request.detailText).font(.caption2.monospaced()).textSelection(.enabled)
          Text("The dot's complete answer:").font(.caption2).foregroundStyle(.secondary)
          Text(verbatim: request.answerText ?? "None").font(.caption2.monospaced()).textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .font(.caption2)
      .accessibilityIdentifier("request-audit-details-\(request.id)")
    }
    .padding(8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 10).fill(.white.opacity(0.05)))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("request-audit-\(request.id)")
  }
}

/// The session and the times a request moved: seen, answered, sent, confirmed, escalated.
func requestTimes(_ request: RequestAudit) -> String {
  let format = { (time: Double) in Date(timeIntervalSince1970: time / 1000).formatted(date: .abbreviated, time: .shortened) }
  var parts = ["\(request.sessionID)", "seen \(format(request.createdAt))"]
  if let at = request.queuedAt { parts.append("answered \(format(at))\(request.actorSession.map { " by \($0)" } ?? "")") }
  if let at = request.attemptedAt { parts.append("sent \(format(at))") }
  if let at = request.confirmedAt { parts.append("confirmed \(format(at))") }
  if let at = request.escalatedAt { parts.append("escalated \(format(at))") }
  return parts.joined(separator: " · ")
}

/// A session the dot supervises or asks to. Approving and ending both ask first; neither starts a turn.
struct SupervisionRow: View {
  let store: Store
  let dot: String
  let binding: Supervision

  var body: some View {
    let busy = store.memories[dot]?.supervising.contains(binding.id) == true
    VStack(alignment: .leading, spacing: 4) {
      Text(verbatim: binding.sessionID).font(.callout.monospaced()).textSelection(.enabled)
      Text(verbatim: binding.directory).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
      Text(verbatim: "\(binding.state == "requested" ? "Waiting for you" : "Active"), \(binding.modeTitle), busy alert after \(binding.busyMinutes) min")
        .font(.caption)
      HStack(spacing: 10) {
        Text(verbatim: supervisionTimes(binding)).font(.caption2).foregroundStyle(.tertiary)
          .accessibilityIdentifier("supervision-times-\(binding.id)")
        Spacer()
        if busy {
          Text("Saving…").font(.caption2).foregroundStyle(.secondary)
        } else {
          if binding.state == "requested" {
            Button("Approve…") { confirm(approve: true) }
              .accessibilityIdentifier("supervision-approve-\(binding.id)")
          }
          Button(binding.state == "requested" ? "Decline…" : "Revoke…") { confirm(approve: false) }
            .accessibilityIdentifier("supervision-end-\(binding.id)")
        }
      }
      .buttonStyle(.plain)
      .font(.caption2.weight(.semibold))
    }
    .padding(8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 10).fill(.white.opacity(0.05)))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("memory-supervision-\(binding.id)")
  }

  /// Asks first, with Cancel as the default for Return and Escape.
  private func confirm(approve: Bool) {
    let alert = NSAlert()
    if approve {
      alert.messageText = "Let \(dot) \(binding.modeTitle) this session?"
      alert.informativeText = "\(binding.sessionID) in \(binding.directory). \(dot) will hear when it finishes a turn, fails, waits for a permission or question, or runs over \(binding.busyMinutes) minutes\(binding.mode == "send" ? ", and may write messages into it" : "")."
      alert.addButton(withTitle: "Cancel")
      alert.addButton(withTitle: "Approve")
    } else {
      alert.messageText = binding.state == "requested" ? "Decline this request?" : "Stop \(dot) supervising this session?"
      alert.informativeText = "\(binding.sessionID) in \(binding.directory). Only you can bind it again."
      alert.addButton(withTitle: "Cancel")
      alert.addButton(withTitle: binding.state == "requested" ? "Decline" : "Revoke").hasDestructiveAction = true
    }
    guard runAlert(alert, store) == .alertSecondButtonReturn else { return }
    store.changeSupervision(dot, binding, approve: approve)
  }
}
