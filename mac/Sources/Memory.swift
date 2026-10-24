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

/// A new feed trigger the owner is writing. Saving makes a draft to review; it runs nothing.
struct TriggerDraft: Equatable {
  var open = false
  var responsibility: Int?
  var repository = ""
  var reasons: Set<String> = ["Review requested"]
  var task = ""

  /// What to send, or a message for a value the daemon would refuse, so nothing is sent.
  func fields() throws -> [String: Any] {
    guard let responsibility else { throw MemoryInvalid("Pick an active responsibility.") }
    let repo = repository.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard repo.range(of: "^[a-z0-9][a-z0-9-]{0,38}/[a-z0-9._-]{1,100}$", options: .regularExpression) != nil else {
      throw MemoryInvalid("Name the repository as owner/name, as GitHub shows it.")
    }
    guard !reasons.isEmpty else { throw MemoryInvalid("Pick at least one reason.") }
    let text = task.trimmingCharacters(in: .whitespacesAndNewlines)
    if text.isEmpty { throw MemoryInvalid("Write the instruction the dot gets with each wake.") }
    if text.utf16.count > memoryTextLimit { throw MemoryInvalid("The instruction must be at most \(memoryTextLimit) characters.") }
    return [
      "responsibility": responsibility,
      "repository": repo,
      "reasons": triggerReasons.filter { reasons.contains($0) },
      "task": text,
    ]
  }
}

/// A trigger's preview as shown: loading, the daemon's read, or why it failed.
enum PreviewShown: Equatable {
  case loading
  case loaded(TriggerPreview)
  case failed(String)
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
  /// The new trigger form, triggers being changed, whether a draft is being saved, and open previews.
  var triggerDraft = TriggerDraft()
  var triggering: Set<Int> = []
  var savingTrigger = false
  var previews: [Int: PreviewShown] = [:]
  private(set) var saving: Set<MemoryKey> = []
  private(set) var adding = false
  private var writes = 0
  private var reads = 0
  /// The note search box, the words last searched for, and what that search found.
  var searchDraft = ""
  private(set) var submitted: String?
  private(set) var search: NoteSearch?
  private(set) var searchError: String?
  private(set) var searching = false
  private var searches = 0
  /// Each note's source the owner opened, by note ID.
  private(set) var sources: [Int: OpenSource] = [:]
  private var sourceReads = 0

  struct SearchRun {
    fileprivate let number: Int
    fileprivate let writes: Int
    let query: String
  }

  enum SourceShown: Equatable {
    /// A read in flight, by its number.
    case loading(Int)
    case loaded(NoteSourceRead)
    case failed(String)
  }

  /// A source the owner opened, for the note's version and recorded source at the time. A read
  /// that shows either changed closes it, so an old edited flag or message is never left shown.
  struct OpenSource: Equatable {
    let version: Int
    let source: NoteSource
    var shown: SourceShown
  }

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
    let shown = Set(memory.notes.map(\.id))
    sources = sources.filter { shown.contains($0.key) }
    for note in memory.notes { dropStaleSource(note) }
    return true
  }

  /// Closes a note's open or in-flight source once the note is at another version or has another
  /// source, as after an edit here, a conflict or another client's edit, so it's read again if wanted.
  private mutating func dropStaleSource(_ note: MemoryNote) {
    guard let open = sources[note.id], open.version != note.version || open.source != note.source else { return }
    sources[note.id] = nil
  }

  /// The dot's conversation as the notch last read it. Any change, including the first one known,
  /// closes every open and in-flight source, since none was read under a binding this one confirms.
  private(set) var boundSession: String?

  mutating func bind(_ session: String?) {
    if boundSession != session { sources = [:] }
    boundSession = session
  }

  /// Starts searching the dot's notes for `query`. A blank query clears the search instead.
  mutating func startSearch(_ query: String) -> SearchRun? {
    let words = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !words.isEmpty else {
      clearSearch()
      return nil
    }
    searches += 1
    submitted = words
    searching = true
    searchError = nil
    return SearchRun(number: searches, writes: writes, query: words)
  }

  /// The last search again, as after a change to the notes. Nil when no search is shown.
  mutating func rerunSearch() -> SearchRun? {
    guard let submitted else { return nil }
    return startSearch(submitted)
  }

  /// Shows a search's answer unless a newer search began, the search was cleared, or any change
  /// began or ended since it did: whoever made that change searches again when it settles.
  mutating func finishSearch(_ run: SearchRun, _ result: Result<NoteSearch, MemoryInvalid>) -> Bool {
    guard run.number == searches, submitted == run.query, run.writes == writes, saving.isEmpty, !adding else { return false }
    searching = false
    switch result {
    case .success(let found):
      search = found
      searchError = nil
    case .failure(let failure):
      search = nil
      searchError = failure.message
    }
    return true
  }

  mutating func clearSearch() {
    searches += 1
    searchDraft = ""
    submitted = nil
    search = nil
    searchError = nil
    searching = false
  }

  /// Starts reading where a note, at `version`, was saved from. Nil while a read for that same
  /// version and source is already running.
  mutating func startSource(_ note: Int, version: Int, _ source: NoteSource) -> Int? {
    if let open = sources[note], open.version == version, open.source == source, case .loading = open.shown { return nil }
    sourceReads += 1
    sources[note] = OpenSource(version: version, source: source, shown: .loading(sourceReads))
    return sourceReads
  }

  /// Shows a source read only if it's still the one open for that note, and it answers for that
  /// note and, when found, for the very message and session the note recorded.
  mutating func finishSource(_ note: Int, _ number: Int, _ result: Result<NoteSourceRead, MemoryInvalid>) -> Bool {
    guard var open = sources[note], open.shown == .loading(number) else { return false }
    switch result {
    case .failure(let failure):
      open.shown = .failed(failure.message)
    case .success(let read):
      let matches = read.note == note && (read.state != "found"
        || (read.message?.id == open.source.messageID && read.message?.sessionID == open.source.sessionID))
      open.shown = matches ? .loaded(read) : .failed("The daemon answered for another message or conversation, so nothing is shown. Refresh.")
    }
    sources[note] = open
    return true
  }

  mutating func closeSource(_ note: Int) {
    sources[note] = nil
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
    if case .note(let note) = item { dropStaleSource(note) }
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
    case .note:
      memory?.notes.removeAll { $0.id == key.id }
      sources[key.id] = nil
      if let found = search {
        search = NoteSearch(query: found.query, results: found.results.filter { $0.id != key.id }, more: found.more)
      }
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

/// What the notch says about a note's source, apart from the message itself.
func sourceSummary(_ read: NoteSourceRead, dot: String) -> String {
  let edited = read.edited == true ? " The note was edited since, so this is only where it was first saved, not where its current text came from." : ""
  switch read.state {
  case "found":
    let who = read.message?.role == "assistant" ? "\(dot)'s message" : "a message"
    let when = read.message.map { Date(timeIntervalSince1970: $0.time / 1000).formatted(date: .abbreviated, time: .shortened) } ?? "at an unknown time"
    return "Saved by \(who), \(when), in its current conversation: the message whose dot_note saved this note, not proof that the note is true.\(edited)"
  case "unknown":
    return "Source unknown: saved before sources were kept, by you, or from a message open-dot couldn't confirm."
  case "gone":
    return "Source gone: \(read.reason ?? "OpenCode no longer has that message.")\(edited)"
  default:
    return "Source unavailable: \(read.reason ?? "open-dot can't read it.")\(edited)"
  }
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
            searchBox
            searchResults
            ForEach(memory.notes) { MemoryRow(store: store, dot: name, item: .note($0)) }
            addNote
          }
          section("Responsibilities") {
            if memory.responsibilities.isEmpty { empty }
            ForEach(memory.responsibilities) { MemoryRow(store: store, dot: name, item: .responsibility($0)) }
            TriggerList(store: store, dot: name, memory: memory)
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

  /// Searches only this dot's saved notes, without starting a turn.
  private var searchBox: some View {
    let draft = Binding { store.memories[name]?.searchDraft ?? "" } set: { store.memories[name, default: MemoryState()].searchDraft = $0 }
    let state = store.memories[name]
    let blank = draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    return HStack {
      TextField("Search notes", text: draft)
        .textFieldStyle(.plain)
        .onSubmit { store.searchNotes(name) }
        .accessibilityIdentifier("memory-search-field")
      if state?.searching == true {
        Text("Searching…").font(.caption2).foregroundStyle(.secondary)
      }
      Button("Search") { store.searchNotes(name) }
        .disabled(blank)
        .opacity(blank ? 0.4 : 1)
        .accessibilityIdentifier("memory-search")
      if state?.submitted != nil {
        Button("Clear") { store.memories[name]?.clearSearch() }
          .accessibilityIdentifier("memory-search-clear")
      }
    }
    .buttonStyle(.plain)
    .font(.caption.weight(.semibold))
    .padding(8)
    .background(RoundedRectangle(cornerRadius: 10).fill(.white.opacity(0.05)))
  }

  @ViewBuilder private var searchResults: some View {
    let state = store.memories[name]
    if let error = state?.searchError {
      Text(verbatim: error).font(.caption2).foregroundStyle(.red)
    }
    if let found = state?.search {
      Text(verbatim: found.results.isEmpty
        ? "No saved notes match “\(found.query)”."
        : "\(found.results.count)\(found.more ? "+" : "") saved notes match “\(found.query)”, most recently changed first.")
        .font(.caption2).foregroundStyle(.secondary)
        .accessibilityIdentifier("memory-search-summary")
      ForEach(found.results) { NoteMatchRow(store: store, dot: name, match: $0) }
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
      RunList(store: store, key: RunListKey(dot: dot, responsibility: responsibility.id))
    case .reminder(let reminder):
      Text(verbatim: reminder.text).font(.callout)
      Text(verbatim: when(reminder)).font(.caption).foregroundStyle(.secondary)
    }
  }

  private var meta: String {
    switch item {
    case .note(let note): memoryChange(note.updatedAt, by: note.updatedBy, dot: dot) + (note.source == nil ? " · source unknown" : "")
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

/// A note a search found, with where it was saved from when that's known.
struct NoteMatchRow: View {
  let store: Store
  let dot: String
  let match: NoteMatch

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(verbatim: match.snippet).font(.callout).textSelection(.enabled)
      HStack(spacing: 10) {
        Text(verbatim: "#\(match.id) · \(memoryChange(match.updatedAt, by: match.updatedBy, dot: dot))\(match.source == nil ? " · source unknown" : match.source?.edited == true ? " · edited since saved" : "")")
          .font(.caption2).foregroundStyle(.tertiary)
        Spacer()
        if let source = match.source { toggle(source) }
      }
      .buttonStyle(.plain)
      .font(.caption2.weight(.semibold))
      NoteSourcePanel(store: store, dot: dot, note: match.id)
    }
    .padding(8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 10).fill(.white.opacity(0.08)))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("memory-search-result-\(match.id)")
  }

  @ViewBuilder private func toggle(_ source: NoteSource) -> some View {
    switch store.memories[dot]?.sources[match.id]?.shown {
    case .loading?:
      Text("Reading…").foregroundStyle(.secondary)
    case nil:
      Button("Source") { store.readSource(dot, note: match.id, version: match.version, source: source) }
        .accessibilityIdentifier("memory-source-\(match.id)")
    default:
      Button("Hide source") { store.memories[dot]?.closeSource(match.id) }
        .accessibilityIdentifier("memory-source-hide-\(match.id)")
    }
  }
}

/// A note's source as the daemon read it. The message's text is the conversation's data, shown as
/// plain text, never as instructions, Markdown or links.
struct NoteSourcePanel: View {
  let store: Store
  let dot: String
  let note: Int

  var body: some View {
    switch store.memories[dot]?.sources[note]?.shown {
    case .failed(let message)?:
      Text(verbatim: "\(message) · click to close").font(.caption2).foregroundStyle(.red)
        .onTapGesture { store.memories[dot]?.closeSource(note) }
    case .loaded(let read)?:
      VStack(alignment: .leading, spacing: 4) {
        Text(verbatim: sourceSummary(read, dot: dot)).font(.caption2).foregroundStyle(.secondary)
        if let message = read.message {
          Text("The message, as the conversation's data:").font(.caption2).foregroundStyle(.tertiary)
          Text(verbatim: message.text.isEmpty ? "(no text)" : message.text)
            .font(.caption).textSelection(.enabled)
            .accessibilityIdentifier("memory-source-text-\(note)")
          if !message.tools.isEmpty {
            Text(verbatim: "Tools: \(message.tools.joined(separator: ", "))").font(.caption2).foregroundStyle(.tertiary)
          }
          if message.truncated {
            Text("Only the start of the message is shown.").font(.caption2).foregroundStyle(.tertiary)
          }
        }
      }
      .padding(6)
      .background(RoundedRectangle(cornerRadius: 8).fill(.white.opacity(0.04)))
    default:
      EmptyView()
    }
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

/// A responsibility's scheduled runs, newest first, read only once the owner shows them.
struct RunList: View {
  let store: Store
  let key: RunListKey

  var body: some View {
    let state = store.runLists[key]
    VStack(alignment: .leading, spacing: 4) {
      Button(state == nil ? "Show runs" : "Hide runs") { store.toggleRuns(key) }
        .buttonStyle(.plain)
        .font(.caption2.weight(.semibold))
        .accessibilityIdentifier("runs-toggle-\(key.responsibility)")
      if let state {
        if let error = state.error {
          Text(verbatim: error).font(.caption2).foregroundStyle(.red)
        }
        let rows = state.rows
        if rows.isEmpty && state.error == nil {
          Text("No scheduled runs recorded").font(.caption2).foregroundStyle(.tertiary)
        }
        ForEach(rows) { RunRow(store: store, dot: key.dot, run: $0) }
        if state.older != nil {
          Button(state.loadingOlder ? "Loading…" : "Load older runs") { store.loadOlderRuns(key) }
            .buttonStyle(.plain)
            .font(.caption2.weight(.semibold))
            .disabled(state.loadingOlder)
            .accessibilityIdentifier("runs-older-\(key.responsibility)")
        }
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("runs-\(key.responsibility)")
  }
}

/// One run: its state, times and the evidence the daemon could attribute to it, as data.
struct RunRow: View {
  let store: Store
  let dot: String
  let run: ResponsibilityRun

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(verbatim: "Run #\(run.id) · \(run.stateTitle)")
        .font(.caption.weight(.medium))
        .foregroundStyle(run.state == "needs-you" ? AnyShapeStyle(.orange) : run.unresolved ? AnyShapeStyle(.yellow) : AnyShapeStyle(.primary))
      Text(verbatim: runTimes(run)).font(.caption2).foregroundStyle(.tertiary)
      if let error = run.turn?.error {
        Text(verbatim: error).font(.caption2).foregroundStyle(.secondary).textSelection(.enabled)
      }
      if let note = run.attributionNote {
        Text(note).font(.caption2).foregroundStyle(.secondary)
      }
      if let result = run.result {
        Text("The start of the dot's last reply in that turn, as its data:").font(.caption2).foregroundStyle(.secondary)
        Text(verbatim: result.text).font(.caption).textSelection(.enabled).lineLimit(8)
      }
      HStack(spacing: 10) {
        evidenceButton("Prompt", message: run.messageID)
        if let result = run.result { evidenceButton("Result", message: result.messageID) }
      }
      evidencePanel("The run's prompt", message: run.messageID)
      if let result = run.result { evidencePanel("The dot's reply", message: result.messageID) }
      if !run.workers.isEmpty {
        Text(run.workers.contains(where: { $0.provisional == true })
          ? "Delegated while this run's turn held only its prompt. The turn hasn't ended, so later input may still make these not the run's. A worker's report is evidence, not acceptance."
          : "Delegated in this run's own turn. A worker's report is evidence, not acceptance.")
          .font(.caption2).foregroundStyle(.secondary)
      }
      if let withheld = run.withheldWorkers, withheld > 0 {
        Text(verbatim: "\(withheld) worker\(withheld == 1 ? "" : "s") delegated in this turn \(withheld == 1 ? "isn't" : "aren't") shown as the run's, because the turn also handled other input or its history was incomplete.")
          .font(.caption2).foregroundStyle(.secondary)
      }
      ForEach(run.workers) { worker in
        HStack(alignment: .firstTextBaseline) {
          Text(verbatim: worker.line)
            .font(.caption2)
            .foregroundStyle(worker.needs.isEmpty ? AnyShapeStyle(.primary) : AnyShapeStyle(.orange))
            .lineLimit(2)
          Spacer()
          Button(store.workerBusy.contains(worker.id) ? "Opening…" : "Open session") { store.openWorker(id: worker.id) }
            .buttonStyle(.plain)
            .font(.caption2.weight(.semibold))
            .disabled(store.workerBusy.contains(worker.id))
            .accessibilityIdentifier("run-worker-open-\(worker.id)")
        }
        if let notice = store.workerNotices[worker.id] {
          Text(verbatim: notice).font(.caption2).foregroundStyle(.secondary).textSelection(.enabled)
        }
      }
      DisclosureGroup("Details") {
        VStack(alignment: .leading, spacing: 2) {
          Text(verbatim: "Goal then: \(run.snapshot.goal)").font(.caption2)
          Text(verbatim: "Next action then: \(run.snapshot.nextAction)").font(.caption2)
          Text(verbatim: "Session \(run.sessionID) · prompt \(run.messageID)").font(.caption2.monospaced())
          if let result = run.result {
            Text(verbatim: "Reply \(result.messageID)").font(.caption2.monospaced())
          }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .font(.caption2)
      .accessibilityIdentifier("run-details-\(run.id)")
    }
    .padding(6)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 8).fill(.white.opacity(0.04)))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("run-\(run.id)")
  }

  private func evidenceKey(_ message: String) -> RunEvidenceKey {
    RunEvidenceKey(dot: dot, run: run.id, message: message)
  }

  /// Shows or hides one message, read through the pinned single-message route. Only reads.
  private func evidenceButton(_ title: String, message: String) -> some View {
    let open = store.runEvidence.shown[evidenceKey(message)] != nil
    return Button(open ? "Hide \(title.lowercased())" : "Show \(title.lowercased())") {
      store.toggleRunEvidence(evidenceKey(message), session: run.sessionID)
    }
    .buttonStyle(.plain)
    .font(.caption2.weight(.semibold))
    .accessibilityIdentifier("run-\(run.id)-\(title.lowercased())")
  }

  @ViewBuilder private func evidencePanel(_ title: String, message: String) -> some View {
    switch store.runEvidence.shown[evidenceKey(message)] {
    case .loading?:
      Text("Loading…").font(.caption2).foregroundStyle(.secondary)
    case .failed(let reason)?:
      Text(verbatim: reason).font(.caption2).foregroundStyle(.red)
    case .read(.gone)?:
      Text(verbatim: "\(title) is no longer in \(dot)'s conversation, so it can't be shown.")
        .font(.caption2).foregroundStyle(.secondary)
    case .read(.elsewhere)?:
      Text(verbatim: "\(title) is in a conversation \(dot) is no longer bound to, or \(dot) isn't ready, so open-dot doesn't read it.")
        .font(.caption2).foregroundStyle(.secondary)
    case .read(.found(let found))?:
      VStack(alignment: .leading, spacing: 3) {
        Text(verbatim: "\(title), as the conversation's data:").font(.caption2).foregroundStyle(.tertiary)
        Text(verbatim: found.text.isEmpty ? "(no text)" : found.text)
          .font(.caption).textSelection(.enabled)
          .accessibilityIdentifier("run-evidence-\(run.id)-\(found.id)")
        Text(verbatim: Date(timeIntervalSince1970: found.time / 1000).formatted(date: .abbreviated, time: .shortened))
          .font(.caption2).foregroundStyle(.tertiary)
      }
      .padding(6)
      .background(RoundedRectangle(cornerRadius: 8).fill(.white.opacity(0.04)))
    case nil:
      EmptyView()
    }
  }
}

/// When a run was due and claimed, and when its turn ended.
func runTimes(_ run: ResponsibilityRun) -> String {
  let format = { (time: Double) in Date(timeIntervalSince1970: time / 1000).formatted(date: .abbreviated, time: .shortened) }
  var parts = ["due \(format(run.dueAt))", "woke \(format(run.claimedAt))"]
  if let ended = run.turn?.endedAt { parts.append("turn ended \(format(ended))") }
  return parts.joined(separator: " · ")
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

/// The daemon's bounds on wakes, mirrored for the confirmation text.
let triggerWakesPerHour = 3
let triggerWakeEvents = 5

/// What the owner confirms before enabling or resuming: the exact filter, destination and
/// instruction, and the revision the confirmation is bound to.
func triggerConfirmation(_ trigger: FeedTrigger, dot: String, goal: String?) -> String {
  """
  When GitHub activity in \(trigger.repository) for \(trigger.reasons.joined(separator: ", ")) reaches your feed, \(dot) is woken in its conversation \(trigger.sessionID) about responsibility #\(trigger.responsibility)\(goal.map { " (\($0))" } ?? "") with this instruction, sent unchanged:

  \(trigger.task)

  Each event's title and details go with it as GitHub's data, never as instructions. Activity already in the feed is recorded without waking. At most \(triggerWakesPerHour) wakes an hour, \(triggerWakeEvents) events each; the rest are skipped and listed here. Revision \(trigger.revision.prefix(12)).
  """
}

/// A trigger's last wake, skips and binding, in one line.
func triggerSummary(_ trigger: FeedTrigger, now: Date = Date()) -> String {
  var parts: [String] = []
  if let wake = trigger.lastWake {
    let delivery = wake.delivery == "admitted" ? "OpenCode has it" : wake.delivery
    parts.append("Last wake \(ago(wake.at, now: now)), \(wake.events.count) \(wake.events.count == 1 ? "event" : "events"), \(delivery)")
  } else {
    parts.append("No wake yet")
  }
  if trigger.skippedCount > 0 { parts.append("\(trigger.skippedCount) skipped") }
  if trigger.baselined > 0 { parts.append("\(trigger.baselined) recorded without waking") }
  parts.append("bound to \(trigger.sessionID)")
  return parts.joined(separator: " · ")
}

/// What a previewed event did or would do.
func triggerOutcome(_ match: TriggerPreview.Match) -> String {
  switch match.outcome {
  case "queued": "a wake was queued; check its delivery status"
  case "skipped": "skipped: \(match.reason ?? "no reason saved")"
  case "baseline": "already in the feed, recorded without waking"
  case "pending": "awaiting the next check of the binding, responsibility and wake limits"
  default: "came before the trigger was enabled, so it never runs"
  }
}

/// The owner's feed triggers, under the responsibilities they wake the dot about, and a form for
/// a new one. Saving makes a draft; only Enable, after showing its exact filter and instruction,
/// runs it. Nothing here starts a turn.
struct TriggerList: View {
  let store: Store
  let dot: String
  let memory: Memory

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("Feed triggers").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
      ForEach(memory.triggers ?? []) { trigger in
        TriggerRow(store: store, dot: dot, trigger: trigger, goal: memory.responsibilities.first { $0.id == trigger.responsibility }?.goal)
      }
      if store.memories[dot]?.triggerDraft.open == true {
        form
      } else {
        Button("New feed trigger…") { store.memories[dot, default: MemoryState()].triggerDraft.open = true }
          .buttonStyle(.plain)
          .font(.caption2.weight(.semibold))
          .disabled(active.isEmpty)
          .opacity(active.isEmpty ? 0.4 : 1)
          .accessibilityIdentifier("trigger-new")
      }
    }
  }

  private var active: [MemoryResponsibility] { memory.responsibilities.filter { $0.status == "active" } }

  private var form: some View {
    let draft = Binding { store.memories[dot]?.triggerDraft ?? TriggerDraft() } set: { store.memories[dot, default: MemoryState()].triggerDraft = $0 }
    let saving = store.memories[dot]?.savingTrigger == true
    return VStack(alignment: .leading, spacing: 6) {
      Picker("Responsibility", selection: draft.responsibility) {
        Text("Choose a responsibility").tag(Int?.none)
        ForEach(active) { Text(verbatim: "#\($0.id) \($0.goal)").tag(Int?.some($0.id)) }
      }
      .accessibilityIdentifier("trigger-responsibility")
      TextField("GitHub repository, owner/name", text: draft.repository)
        .textFieldStyle(.plain)
        .accessibilityIdentifier("trigger-repository")
      LazyVGrid(columns: [GridItem(.adaptive(minimum: 130), alignment: .leading)], alignment: .leading) {
        ForEach(triggerReasons, id: \.self) { reason in
          Toggle(reason, isOn: Binding {
            draft.wrappedValue.reasons.contains(reason)
          } set: { on in
            if on { draft.wrappedValue.reasons.insert(reason) } else { draft.wrappedValue.reasons.remove(reason) }
          })
          .toggleStyle(.checkbox)
        }
      }
      .font(.caption)
      TextField("Instruction the dot gets with each wake", text: draft.task, axis: .vertical)
        .lineLimit(2...6)
        .accessibilityIdentifier("trigger-task")
      Text("Saving makes a draft for you to review and preview. Nothing runs until you enable it.")
        .font(.caption2).foregroundStyle(.secondary)
      HStack {
        Spacer()
        Button("Cancel") { store.memories[dot]?.triggerDraft.open = false }
        Button(saving ? "Saving…" : "Save Draft") { store.createTrigger(dot) }
          .disabled(saving)
          .accessibilityIdentifier("trigger-save")
      }
      .buttonStyle(.plain)
      .font(.caption.weight(.semibold))
    }
    .padding(8)
    .background(RoundedRectangle(cornerRadius: 10).fill(.white.opacity(0.05)))
  }
}

/// One feed trigger: its exact filter and instruction, its last wake and skips, and the owner's
/// preview, enable or resume, pause and revoke. Every change asks first.
struct TriggerRow: View {
  let store: Store
  let dot: String
  let trigger: FeedTrigger
  let goal: String?

  var body: some View {
    let busy = store.memories[dot]?.triggering.contains(trigger.id) == true
    VStack(alignment: .leading, spacing: 4) {
      HStack(alignment: .firstTextBaseline) {
        Text(verbatim: "\(trigger.repository) · \(trigger.reasons.joined(separator: ", "))")
          .font(.callout.weight(.medium)).textSelection(.enabled)
        Spacer()
        Text(trigger.state == "draft" ? "Draft, not enabled" : trigger.state == "paused" ? "Paused" : "Active")
          .font(.caption2)
          .foregroundStyle(trigger.state == "active" ? AnyShapeStyle(.green) : AnyShapeStyle(.secondary))
      }
      Text(verbatim: "Wakes \(dot) about responsibility #\(trigger.responsibility)\(goal.map { ": \($0)" } ?? "")")
        .font(.caption).foregroundStyle(.secondary)
      Text(verbatim: trigger.task).font(.caption).textSelection(.enabled)
        .accessibilityIdentifier("trigger-task-\(trigger.id)")
      Text(verbatim: triggerSummary(trigger)).font(.caption2).foregroundStyle(.tertiary).textSelection(.enabled)
        .accessibilityIdentifier("trigger-summary-\(trigger.id)")
      if let wake = trigger.lastWake {
        DisclosureGroup("Last wake") {
          VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(wake.events.enumerated()), id: \.offset) { _, event in
              Text(verbatim: "\(event.title) · \(event.reason)").font(.caption2).textSelection(.enabled)
            }
            Text(verbatim: wake.messageID).font(.caption2.monospaced()).foregroundStyle(.tertiary).textSelection(.enabled)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        .font(.caption2)
        .accessibilityIdentifier("trigger-last-wake-\(trigger.id)")
      }
      if !trigger.skipped.isEmpty {
        DisclosureGroup("Skipped (\(trigger.skippedCount))") {
          VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(trigger.skipped.enumerated()), id: \.offset) { _, skip in
              Text(verbatim: "\(skip.event.title): \(skip.reason ?? "skipped"), \(ago(skip.at))")
                .font(.caption2).textSelection(.enabled)
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        .font(.caption2)
        .accessibilityIdentifier("trigger-skipped-\(trigger.id)")
      }
      preview
      HStack(spacing: 10) {
        Spacer()
        if busy {
          Text("Saving…").font(.caption2).foregroundStyle(.secondary)
        } else {
          if store.memories[dot]?.previews[trigger.id] == nil {
            Button("Preview") { store.previewTrigger(dot, trigger) }
              .accessibilityIdentifier("trigger-preview-\(trigger.id)")
          } else {
            Button("Hide Preview") { store.memories[dot]?.previews[trigger.id] = nil }
          }
          if trigger.state == "active" {
            Button("Pause…") { confirm(.pause) }
              .accessibilityIdentifier("trigger-pause-\(trigger.id)")
          } else {
            Button(trigger.state == "paused" ? "Resume…" : "Enable…") { confirm(.enable) }
              .accessibilityIdentifier("trigger-enable-\(trigger.id)")
          }
          Button(trigger.state == "draft" ? "Discard…" : "Revoke…") { confirm(.revoke) }
            .accessibilityIdentifier("trigger-revoke-\(trigger.id)")
        }
      }
      .buttonStyle(.plain)
      .font(.caption2.weight(.semibold))
    }
    .padding(8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 10).fill(.white.opacity(0.05)))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("memory-trigger-\(trigger.id)")
  }

  /// The saved events the filter matches, as GitHub's data in plain text, and the exact wake text.
  @ViewBuilder private var preview: some View {
    switch store.memories[dot]?.previews[trigger.id] {
    case .loading?:
      Text("Reading the saved feed…").font(.caption2).foregroundStyle(.secondary)
    case .failed(let message)?:
      Text(verbatim: "\(message) · click to close").font(.caption2).foregroundStyle(.red)
        .onTapGesture { store.memories[dot]?.previews[trigger.id] = nil }
    case .loaded(let read)?:
      VStack(alignment: .leading, spacing: 4) {
        Text(verbatim: read.total == 0
          ? "No saved feed event matches yet. Previewing queued nothing."
          : "\(read.total) saved feed \(read.total == 1 ? "event matches" : "events match"), newest first. Previewing queued nothing.")
          .font(.caption2).foregroundStyle(.secondary)
        ForEach(Array(read.matches.enumerated()), id: \.offset) { _, match in
          Text(verbatim: "\(match.event.title) · \(match.event.reason) · \(triggerOutcome(match))")
            .font(.caption2).textSelection(.enabled)
        }
        if let sample = read.sample {
          Text("The wake about the newest would read exactly:").font(.caption2).foregroundStyle(.tertiary)
          Text(verbatim: sample).font(.caption2.monospaced()).textSelection(.enabled)
            .accessibilityIdentifier("trigger-sample-\(trigger.id)")
        }
      }
      .padding(6)
      .background(RoundedRectangle(cornerRadius: 8).fill(.white.opacity(0.04)))
    case nil:
      EmptyView()
    }
  }

  /// Asks first, with Cancel as the default for Return and Escape. Enabling shows the exact
  /// filter, destination and instruction, and sends the revision shown.
  private func confirm(_ action: TriggerAction) {
    let alert = NSAlert()
    switch action {
    case .enable:
      let resume = trigger.state == "paused"
      alert.messageText = resume ? "Resume this feed trigger?" : "Enable this feed trigger?"
      alert.informativeText = triggerConfirmation(trigger, dot: dot, goal: goal)
      alert.addButton(withTitle: "Cancel")
      alert.addButton(withTitle: resume ? "Resume" : "Enable")
    case .pause:
      alert.messageText = "Pause this feed trigger?"
      alert.informativeText = "Wakes not yet sent are cancelled. Activity while it's paused never runs, even after you resume it."
      alert.addButton(withTitle: "Cancel")
      alert.addButton(withTitle: "Pause")
    case .revoke:
      alert.messageText = trigger.state == "draft" ? "Discard this draft?" : "Revoke this feed trigger?"
      alert.informativeText = "Wakes not yet sent are cancelled. To use it again, create a new trigger."
      alert.addButton(withTitle: "Cancel")
      alert.addButton(withTitle: trigger.state == "draft" ? "Discard" : "Revoke").hasDestructiveAction = true
    }
    guard runAlert(alert, store) == .alertSecondButtonReturn else { return }
    store.changeTrigger(dot, trigger, action)
  }
}
