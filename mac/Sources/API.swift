import CryptoKit
import Foundation

/// "permission", "question" or both, as a row says them.
func requestKinds(_ kinds: [String]) -> String {
  kinds.contains("permission") && kinds.contains("question") ? "permission, question" : kinds.contains("question") ? "question" : "permission"
}

struct Dot: Decodable, Equatable {
  struct Worker: Decodable, Equatable {
    let id: Int
    /// "creating", "running", "stopping", or "done" once stopped.
    let state: String
    var outcome: String? = nil
    let task: String
    /// What you should answer now: escalated, unknown, or unanswered past the grace period. Older
    /// daemons send none.
    var needs: [String]? = nil
    /// What its dot is handling for it now.
    var waiting: [String]? = nil
    /// A few words about the dot's latest answer for it.
    var answered: String? = nil

    var needsYou: Bool { !(needs ?? []).isEmpty }

    /// The row's status: what it needs from you first, then what the dot handles, else its state.
    var status: String {
      if needsYou {
        let waiting = "needs you: \(requestKinds(needs ?? []))"
        return state == "stopping" ? "stopping, not confirmed · \(waiting)" : waiting
      }
      if state == "running", let waiting, !waiting.isEmpty { return "dot handling: \(requestKinds(waiting))" }
      switch state {
      case "stopping": return "stopping, not confirmed"
      case "done": return outcome ?? "done"
      default: return state
      }
    }

    /// The row's text: number, status, task and the dot's latest answer.
    var line: String { "#\(id) \(status) · \(task)\(answered.map { " · \($0)" } ?? "")" }

    /// Its session exists once it's past creating.
    var canOpen: Bool { state != "creating" }
    /// A stop that OpenCode hasn't confirmed can be tried again.
    var canStop: Bool { state != "done" }
  }

  /// A session with requests outside the unfinished workers' rows: a Threads worker of the dot's
  /// waiting on something now, or any session with an answer whose outcome is unknown, which
  /// stays. Threads keeps a Threads worker's lifecycle, so the notch only opens its session.
  struct SessionRequest: Decodable, Equatable {
    /// Its newest request, which opens its session.
    let request: Int
    /// "threads", or "worker" for an open-dot worker that finished.
    let source: String
    var worker: Int? = nil
    let sessionID: String
    let title: String
    let directory: String
    var needs: [String]? = nil
    var waiting: [String]? = nil
    var answered: String? = nil

    var needsYou: Bool { !(needs ?? []).isEmpty }

    var line: String {
      let status = needsYou
        ? "needs you: \(requestKinds(needs ?? []))"
        : (waiting ?? []).isEmpty ? "answered" : "dot handling: \(requestKinds(waiting ?? []))"
      let from = source == "threads" ? "Threads" : "Worker #\(worker ?? 0), finished,"
      return "\(from) \(status) · \(title)\(answered.map { " · \($0)" } ?? "")"
    }
  }

  /// The dot has an avatar. Its revision changes whenever the file is replaced or rewritten.
  struct Avatar: Decodable, Equatable {
    let revision: String
  }

  let name: String
  let purpose: String?
  let busy: Bool
  let workers: [Worker]
  /// Older daemons send none.
  var sessions: [SessionRequest]? = nil
  /// Nil without one, and from older daemons.
  var avatar: Avatar? = nil

  /// How many of its workers and other sessions wait on you.
  var needsYouCount: Int { workers.filter(\.needsYou).count + (sessions ?? []).filter(\.needsYou).count }
}

/// A worker's permission request or question and what became of the dot's answer, for review.
struct RequestAudit: Decodable, Equatable, Identifiable {
  struct Field: Decodable, Equatable {
    let key: String
    var title: String? = nil
    var description: String? = nil
  }

  /// What OpenCode showed: an action and its resources, or a form's title and fields.
  struct Detail: Decodable, Equatable {
    let kind: String
    var action: String? = nil
    var resources: [String]? = nil
    var message: String? = nil
    var title: String? = nil
    var fields: [Field]? = nil
  }

  let id: Int
  /// "worker" or "threads".
  let source: String
  var worker: Int? = nil
  let sessionID: String
  let title: String
  let kind: String
  /// OpenCode's own ID for the permission request or form.
  let requestID: String
  /// The complete request and answer as the daemon saved them, as indented JSON.
  let detailText: String
  var answerText: String? = nil
  let state: String
  let needsYou: Bool
  let detail: Detail
  var reason: String? = nil
  var summary: String? = nil
  var actorSession: String? = nil
  let createdAt: Double
  var queuedAt: Double? = nil
  var attemptedAt: Double? = nil
  var confirmedAt: Double? = nil
  var escalatedAt: Double? = nil
  var goneAt: Double? = nil

  var stateTitle: String {
    switch state {
    case "open": return goneAt == nil ? "dot handling" : "gone unanswered"
    case "queued": return "answer queued"
    case "answering": return "sending"
    case "answered": return "confirmed"
    case "unknown": return "outcome unknown"
    case "stale": return "not sent"
    case "escalated": return "escalated to you"
    default: return state
    }
  }

  /// The request's own words, which are the worker's data.
  var asked: String {
    if detail.kind == "permission" {
      return "\(detail.action ?? "?"): \((detail.resources ?? []).joined(separator: ", "))"
    }
    let fields = (detail.fields ?? []).map { $0.title ?? $0.description ?? $0.key }
    return ([detail.title ?? ""] + fields).filter { !$0.isEmpty }.joined(separator: " · ")
  }

  var line: String {
    let from = source == "worker" ? "worker #\(worker ?? 0)" : "Threads"
    return "#\(id) \(kind) from \(from) · \(stateTitle)\(summary.map { " · \($0)" } ?? "")"
  }
}

/// One page of the audit. `next`, when there may be more, is where the next older page starts.
struct RequestAuditPage: Decodable, Equatable {
  let requests: [RequestAudit]
  var next: Int? = nil
}

/// Pages the notch has read, newest first by ID. Each value is one opening of the list, and each
/// read carries that opening, so a read begun before the list was hidden and shown again changes
/// nothing. Within an opening, a read applies only to rows no later read already set, moves the
/// error only if no later read settled first, and moves the older-page cursor only by reaching
/// further than the rows loaded so far, or as far as a later read did not, so a slow answer can't
/// bring back an older state, and older pages stay loaded.
struct NewestFirstPages<Row: Identifiable & Equatable>: Equatable where Row.ID == Int {
  struct Read: Equatable {
    fileprivate let opening: UUID
    fileprivate let number: Int
  }

  private let opening = UUID()
  private var byID: [Int: Row] = [:]
  private var readOf: [Int: Int] = [:]
  private var reads = 0
  private var cursorRead = 0
  private var settledRead = 0
  /// Where the next older page starts, from the page that reached the oldest loaded row.
  private(set) var older: Int? = nil
  var loadingOlder = false
  /// Why the latest settled read failed, if it did.
  private(set) var error: String? = nil

  /// Newest first.
  var rows: [Row] { byID.values.sorted { $0.id > $1.id } }

  mutating func startRead() -> Read {
    reads += 1
    return Read(opening: opening, number: reads)
  }

  /// True when the read belongs to this opening.
  func isCurrent(_ read: Read) -> Bool { read.opening == opening }

  mutating func apply(_ read: Read, rows page: [Row], next: Int?, older isOlder: Bool) {
    guard isCurrent(read) else { return }
    if isOlder { loadingOlder = false }
    let oldest = byID.keys.min()
    for row in page where (readOf[row.id] ?? 0) < read.number {
      byID[row.id] = row
      readOf[row.id] = read.number
    }
    // The page that reaches past every row loaded so far says where the next older one starts.
    // One that only reaches the oldest loaded row moves it only if no later read already did.
    if let last = page.last?.id, oldest == nil || last < oldest! || (last == oldest! && read.number > cursorRead) {
      older = next
      cursorRead = max(cursorRead, read.number)
    } else if isOlder && page.isEmpty {
      older = nil
    } else if oldest == nil && page.isEmpty && read.number > cursorRead {
      older = next
      cursorRead = read.number
    }
    if read.number > settledRead {
      settledRead = read.number
      error = nil
    }
  }

  /// A read that failed. Only the latest settled read of this opening shows its error.
  mutating func fail(_ read: Read, _ message: String, older isOlder: Bool) {
    guard isCurrent(read) else { return }
    if isOlder { loadingOlder = false }
    if read.number > settledRead {
      settledRead = read.number
      error = message
    }
  }
}

/// The audit pages the notch has read for one dot.
typealias RequestAuditState = NewestFirstPages<RequestAudit>

extension NewestFirstPages where Row == RequestAudit {
  mutating func apply(_ read: Read, _ page: RequestAuditPage, older isOlder: Bool) {
    apply(read, rows: page.requests, next: page.next, older: isOlder)
  }
}

/// One scheduled run of a responsibility: what the daemon saved when it claimed the run, and what
/// it last saw of the run's turn in OpenCode's public history.
struct ResponsibilityRun: Decodable, Equatable, Identifiable {
  /// The responsibility as it was at the claim.
  struct Snapshot: Decodable, Equatable {
    let goal: String
    let nextAction: String
  }

  struct Turn: Decodable, Equatable {
    var outcome: String? = nil
    var error: String? = nil
    var endedAt: Double? = nil
  }

  /// The dot's last reply in the run's own turn. Only a turn that held nothing else has one.
  struct Result: Decodable, Equatable {
    let messageID: String
    let text: String
  }

  /// A worker the run's own turn delegated.
  struct Worker: Decodable, Equatable, Identifiable {
    let id: Int
    let state: String
    var outcome: String? = nil
    let task: String
    let sessionID: String
    var finishedAt: Double? = nil
    let needs: [String]
    /// Linked while the run's turn hadn't ended, so later input may still make it not the run's.
    var provisional: Bool? = nil

    var line: String {
      let status = !needs.isEmpty ? "needs you: \(needs.joined(separator: ", "))"
        : state == "done" ? "finished (\(outcome ?? "unknown"))"
        : state
      return "Worker #\(id): \(task) · \(status)"
    }
  }

  let id: Int
  let responsibility: Int
  let dueAt: Double
  let claimedAt: Double
  let snapshot: Snapshot
  let sessionID: String
  let messageID: String
  /// queued, admitted, running, needs-you, finished-turn, failed or unknown.
  let state: String
  var delivery: String? = nil
  var turn: Turn? = nil
  /// exclusive, shared or unknown once the turn ended.
  var attribution: String? = nil
  var result: Result? = nil
  let workers: [Worker]
  /// Workers linked to the run whose turn ended shared or unknown, so not shown as its own.
  var withheldWorkers: Int? = nil

  /// The state in the owner's words. A finished turn never says the goal was met.
  var stateTitle: String {
    switch state {
    case "queued": return delivery == "sending" ? "sending, not confirmed" : "queued"
    case "admitted": return "admitted, not started"
    case "running": return "running"
    case "needs-you": return "needs you"
    case "finished-turn": return "turn finished, goal not checked"
    case "failed": return turn?.outcome == "interrupted" ? "interrupted" : "failed"
    case "unknown": return "outcome unknown"
    default: return state
    }
  }

  /// Still waiting on something, or never to be known: shown as unresolved.
  var unresolved: Bool { !["finished-turn", "failed"].contains(state) }

  /// Why no result is shown for a turn that ended.
  var attributionNote: String? {
    switch attribution {
    case "shared"?: return "Its turn also handled other messages, so no reply is attributed to this run."
    case "unknown"?: return "History didn't show what else its turn handled, so no reply is attributed to this run."
    default: return nil
    }
  }
}

/// One page of a responsibility's runs. `next`, when there may be more, is where the next older page starts.
struct RunPage: Decodable, Equatable {
  let runs: [ResponsibilityRun]
  var next: Int? = nil
}

/// The run pages the notch has read for one responsibility.
typealias RunListState = NewestFirstPages<ResponsibilityRun>

extension NewestFirstPages where Row == ResponsibilityRun {
  mutating func apply(_ read: Read, _ page: RunPage, older isOlder: Bool) {
    apply(read, rows: page.runs, next: page.next, older: isOlder)
  }
}

struct RunListKey: Hashable {
  let dot: String
  let responsibility: Int
}

/// One message of a run's evidence: its prompt, or its result once attributed.
struct RunEvidenceKey: Hashable {
  let dot: String
  let run: Int
  let message: String
}

/// What the pinned single-message read found for a piece of a run's evidence.
enum RunEvidenceRead: Equatable {
  case found(Message)
  /// The dot's conversation no longer has that message.
  case gone
  /// The run was in another conversation of the dot, or the dot isn't ready, so it isn't read.
  case elsewhere
}

enum RunEvidenceShown: Equatable {
  case loading
  case read(RunEvidenceRead)
  case failed(String)
}

/// The run evidence the owner opened. Each opening has its own generation, so an answer for one
/// the owner closed or opened again changes nothing.
struct RunEvidenceState: Equatable {
  private(set) var shown: [RunEvidenceKey: RunEvidenceShown] = [:]
  private var generations: [RunEvidenceKey: Int] = [:]

  /// Opens the key, or closes it when open. Returns the generation to read under, or nil once closed.
  mutating func toggle(_ key: RunEvidenceKey) -> Int? {
    let generation = (generations[key] ?? 0) + 1
    generations[key] = generation
    if shown[key] != nil {
      shown[key] = nil
      return nil
    }
    shown[key] = .loading
    return generation
  }

  mutating func finish(_ key: RunEvidenceKey, _ generation: Int, _ result: RunEvidenceShown) {
    guard generations[key] == generation, shown[key] != nil else { return }
    shown[key] = result
  }
}

/// What opening a worker did: a terminal window, or the command on the clipboard instead.
struct WorkerOpened: Decodable, Equatable {
  let opened: Bool
  var terminal: String? = nil
  var copied: Bool? = nil
  let command: String
  var error: String? = nil

  /// What the notch says about it, or nil when the window opened.
  var notice: String? {
    if opened { return nil }
    let reason = error ?? "The terminal didn't open."
    return copied == true
      ? "\(reason) — the command is on your clipboard: \(command)"
      : "\(reason) — copy and run: \(command)"
  }
}

struct MessagePage: Decodable {
  struct Status: Decodable { let id: String; let status: String; var delivery: String? = nil }
  var messages: [Message]
  let sessionID: String?
  let next: String?
  let pending: [Status]?
  let recentEmojis: [String]?
  /// Set when the daemon served its last page because reading OpenCode again failed.
  var refreshError: String? = nil
  var statuses: [String: String] {
    Dictionary((pending ?? []).map { ($0.id, $0.status) }) { first, _ in first }
  }
  /// How each pending send joins the dot's turn: "auto" until the daemon decides, then "queue" or "steer".
  var deliveries: [String: String] {
    Dictionary((pending ?? []).compactMap { item in item.delivery.map { (item.id, $0) } }) { first, _ in first }
  }
}

struct Message: Decodable, Equatable, Identifiable {
  struct Attachment: Decodable, Equatable {
    let index: Int
    let mime: String
    let name: String?

    /// The only types the daemon serves, so the only ones decoded.
    var isImage: Bool {
      let type = mime.split(separator: ";").first.map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
      return ["image/png", "image/jpeg", "image/gif", "image/webp"].contains(type ?? "")
    }
  }

  let id: String
  /// The session the daemon read it from. Missing from a daemon older than Delete.
  let sessionID: String?
  /// Deleted from the notch only. The daemon keeps listing it so pending sends still match by ID.
  var hidden: Bool?
  let kind: String
  let peer: String?
  let text: String
  let tools: [String]?
  let attachments: [Attachment]?
  /// The feed item the owner replied to, as the daemon read it when the message was sent.
  let feed: FeedItem?
  var quote: MessageQuote? = nil
  let time: Double
  var reactions: [Reaction]?
}

struct MessageQuote: Decodable, Equatable {
  let source: String
  let id: String
  let place: String
  let author: String
  let text: String
}

struct Reaction: Decodable, Equatable {
  let dot: String
  let sessionID: String
  let messageID: String
  let actor: String
  let emoji: String?
  let updatedAt: Double
}

struct HiddenMarker: Decodable, Equatable {
  let dot: String
  let sessionID: String
  let messageID: String
}

struct MessageKey: Hashable {
  let dot: String
  let message: String
}

struct AttachmentKey: Hashable {
  let dot: String
  let message: String
  let index: Int
}

struct ImageUpload: Encodable {
  let mime: String
  let name: String
  let data: Data
}

struct FeedItem: Decodable, Equatable, Identifiable {
  let id: Int
  let source: String
  let reason: String
  let title: String
  let context: String
  let url: String?
  let time: Double
  /// The dots the owner sent it to.
  let handedTo: [String]?
}

/// Who last changed a memory item, how it's shown, and when. Each change needs the version seen.
struct MemoryNote: Decodable, Equatable, Identifiable {
  let id: Int
  let version: Int
  let updatedAt: Double
  let updatedBy: String
  let text: String
  /// Where the dot saved it from. Nil means unknown, and older daemons send none.
  var source: NoteSource? = nil
}

/// The dot's session and the message whose dot_note saved a note, as open-dot confirmed them.
/// `edited` means the note changed since, so this is where it was first saved, not proof of its text.
struct NoteSource: Decodable, Equatable {
  let sessionID: String
  let messageID: String
  let edited: Bool
}

/// A saved note that contains every word searched for, as a short snippet.
struct NoteMatch: Decodable, Equatable, Identifiable {
  let id: Int
  let version: Int
  let updatedAt: Double
  let updatedBy: String
  let snippet: String
  var source: NoteSource? = nil
}

/// The notes a search found, most recently changed first. `more` means some weren't returned.
struct NoteSearch: Decodable, Equatable {
  let query: String
  let results: [NoteMatch]
  let more: Bool
}

/// What the daemon read of a note's source: "found" with its message, or "unknown", "unavailable"
/// or "gone" with why not. The message's text is the conversation's data, shown as is.
struct NoteSourceRead: Decodable, Equatable {
  struct Message: Decodable, Equatable {
    let id: String
    let sessionID: String
    let role: String
    let text: String
    let truncated: Bool
    let tools: [String]
    let time: Double
  }

  let note: Int
  let state: String
  var edited: Bool? = nil
  var reason: String? = nil
  var message: Message? = nil
}

struct MemoryResponsibility: Decodable, Equatable, Identifiable {
  let id: Int
  let version: Int
  let updatedAt: Double
  let updatedBy: String
  let goal: String
  let nextAction: String
  let status: String
  /// When the daemon wakes the dot about it, and its next run while active. Older daemons send neither.
  var schedule: ResponsibilitySchedule? = nil
  var nextRunAt: Double? = nil
}

/// Every `everyMinutes`, or daily or weekly (days 0 = Sunday to 6) at `time`, HH:mm in the Mac's time zone.
struct ResponsibilitySchedule: Decodable, Equatable {
  let kind: String
  var everyMinutes: Int? = nil
  var days: [Int]? = nil
  var time: String? = nil

  var summary: String {
    let at = time ?? ""
    switch kind {
    case "interval": return "Every \(everyMinutes ?? 0) min"
    case "daily": return "Daily at \(at)"
    default:
      let names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
      let list = days ?? []
      let named = list == [0, 1, 2, 3, 4, 5, 6] ? "Every day"
        : list == [1, 2, 3, 4, 5] ? "Weekdays"
        : list == [0, 6] ? "Weekends"
        : list.compactMap { names.indices.contains($0) ? names[$0] : nil }.joined(separator: ", ")
      return "\(named) at \(at)"
    }
  }
}

struct MemoryReminder: Decodable, Equatable, Identifiable {
  let id: Int
  let version: Int
  let updatedAt: Double
  let updatedBy: String
  let text: String
  let dueAt: Double
  let everyMinutes: Int?
  /// "scheduled", or "sent" once a one-off reminder went off.
  let state: String
}

/// A dot's binding to a session the owner started. A "requested" one waits for the owner's approval;
/// an "active" one is watched. The directory is what OpenCode reported for the session.
struct Supervision: Decodable, Equatable, Identifiable {
  let id: Int
  let sessionID: String
  let directory: String
  /// "watch", or "send" to also let the dot write into the session.
  let mode: String
  let state: String
  let busyMinutes: Int
  let createdAt: Double
  let activatedAt: Double?

  var modeTitle: String { mode == "send" ? "watch and send" : "watch only" }
}

/// The GitHub reasons a feed trigger can filter on, as the daemon's feed labels them.
let triggerReasons = ["Review requested", "Mentioned", "Team mentioned", "Assigned", "Comment", "Author"]

/// A GitHub feed event a trigger matched, as the daemon read it from its own feed. Its title is
/// GitHub's data, shown as plain text.
struct TriggerEvent: Decodable, Equatable {
  let sourceID: String
  let reason: String
  let repository: String
  let title: String
  let url: String?
  let updatedAt: Double
}

/// The owner's rule that wakes the dot about one responsibility when its GitHub feed shows new
/// activity in one repository for the chosen reasons. Only the owner enables it, at `revision`;
/// its filter and task never change.
struct FeedTrigger: Decodable, Equatable, Identifiable {
  struct Wake: Decodable, Equatable {
    let messageID: String
    let at: Double
    let events: [TriggerEvent]
    /// "queued", "sending", "admitted" (OpenCode has it, not that the dot finished), "cancelled" or "unknown".
    let delivery: String
  }

  struct Skip: Decodable, Equatable {
    let at: Double
    let reason: String?
    let event: TriggerEvent
  }

  let id: Int
  let responsibility: Int
  let sessionID: String
  let repository: String
  let reasons: [String]
  let task: String
  let revision: String
  /// "draft", "active" or "paused".
  let state: String
  let createdAt: Double
  let confirmedAt: Double?
  let baselineAt: Double?
  let lastWake: Wake?
  let baselined: Int
  let skippedCount: Int
  let skipped: [Skip]
}

/// The saved feed events a trigger's filter matches, newest first, and the exact wake text the
/// newest would make. Reading it changes nothing.
struct TriggerPreview: Decodable, Equatable {
  struct Match: Decodable, Equatable {
    let event: TriggerEvent
    /// "queued", "skipped", "baseline", "pending" or "ignored".
    let outcome: String
    var reason: String? = nil
  }

  let total: Int
  let matches: [Match]
  let sample: String?
}

enum TriggerAction {
  case enable, pause, revoke
}

/// An archived message an observation came from, with a short excerpt; `missing` once it's gone.
struct ObservationSource: Decodable, Equatable {
  let messageID: String
  let sessionID: String
  var from: String? = nil
  var date: String? = nil
  var excerpt: String? = nil
  var missing: Bool? = nil
}

/// A row of the dot's observed ledger: what a background observer noted, which the owner may
/// edit or forget. It's data, never instructions, and may be wrong.
struct MemoryObservation: Decodable, Equatable, Identifiable {
  let id: Int
  let version: Int
  let kind: String
  let topic: String
  let text: String
  let priority: Int
  let sessionID: String
  let updatedAt: Double
  let updatedBy: String
  let sources: [ObservationSource]
}

struct Memory: Decodable, Equatable {
  var notes: [MemoryNote]
  var responsibilities: [MemoryResponsibility]
  var reminders: [MemoryReminder]
  /// Requested and active supervisions. Older daemons send none.
  var supervisions: [Supervision]? = nil
  /// Draft, active and paused feed triggers. Older daemons send none.
  var triggers: [FeedTrigger]? = nil
  /// The observed ledger's current rows and how many were superseded. Older daemons send none.
  var observations: [MemoryObservation]? = nil
  /// Where the next older page of current rows starts, when there's one.
  var observationsNext: Int? = nil
  var observationsSuperseded: Int? = nil
}

/// A page of current observed rows, newest first.
struct ObservationPage: Decodable, Equatable {
  let observations: [MemoryObservation]
  let next: Int?
}

/// One source of an observation, read from open-dot's archive: at most 4,000 characters of what
/// was said, as data, or `gone` once the archive no longer has it.
struct ObservationSourceRead: Decodable, Equatable {
  let messageID: String
  let sessionID: String
  let state: String
  var from: String? = nil
  var date: String? = nil
  var text: String? = nil
  var truncated: Bool? = nil
}

enum MemoryKind: String {
  case note = "notes"
  case responsibility = "responsibilities"
  case reminder = "reminders"
  case observation = "observations"
}

struct MemoryKey: Hashable {
  let kind: MemoryKind
  let id: Int
}

enum MemoryItem: Equatable {
  case note(MemoryNote)
  case responsibility(MemoryResponsibility)
  case reminder(MemoryReminder)
  case observation(MemoryObservation)

  var key: MemoryKey {
    switch self {
    case .note(let note): MemoryKey(kind: .note, id: note.id)
    case .responsibility(let item): MemoryKey(kind: .responsibility, id: item.id)
    case .reminder(let reminder): MemoryKey(kind: .reminder, id: reminder.id)
    case .observation(let row): MemoryKey(kind: .observation, id: row.id)
    }
  }
}

/// How the daemon answered a memory change. A conflict carries the item's current value, and
/// `gone` means the dot has no such item any more. Nothing is ever retried on its own.
enum MemoryOutcome: Equatable {
  case saved(MemoryItem)
  case deleted
  case conflict(MemoryItem, String)
  case gone(String)
}

/// A dot's AGENTS.md as the daemon read or saved it. `revision`, the SHA-256 of its bytes, goes
/// with every change, so a file changed since is never overwritten unseen.
struct Instructions: Decodable, Equatable {
  let content: String
  let revision: String
  let canRevert: Bool
}

/// How the daemon answered a save or revert: the file as it now is, or, on a conflict, nothing
/// changed and this is the file as it is on disk.
enum InstructionsOutcome: Equatable {
  case saved(Instructions)
  case conflict(Instructions, String)
}

/// Reads a save's or revert's answer. A 200 that can't be read leaves the outcome unknown; any
/// other refusal throws its message, since nothing was changed.
func instructionsOutcome(status: Int, data: Data) throws -> InstructionsOutcome {
  struct Conflict: Decodable { let error: String?; let current: Instructions }
  struct Failure: Decodable { let error: String }
  let decoder = JSONDecoder()
  switch status {
  case 200:
    guard let saved = try? decoder.decode(Instructions.self, from: data) else { throw APIError.lost }
    return .saved(saved)
  case 409:
    guard let body = try? decoder.decode(Conflict.self, from: data) else {
      throw APIError.server("Unexpected response from the open-dot daemon")
    }
    return .conflict(body.current, body.error ?? "AGENTS.md changed since you loaded it, so nothing was saved.")
  default:
    let message = (try? decoder.decode(Failure.self, from: data))?.error ?? HTTPURLResponse.localizedString(forStatusCode: status)
    throw APIError.server(message)
  }
}

/// A deliverable in a dot's Library: the daemon's private copy of a file one of its workers saved.
/// A list says "present" when the copy is there, private and of its size, without checking its
/// SHA-256; a detail read says "verified" once it has. "missing" and "corrupt" can't be exported.
struct Artifact: Decodable, Equatable, Identifiable {
  let id: Int
  let name: String
  let mime: String
  let size: Int
  let sha256: String
  let createdAt: Double
  let worker: Int
  let sessionID: String
  let path: String
  let status: String

  var kind: String {
    switch mime {
    case "text/markdown": "Markdown"
    case "text/csv": "CSV"
    case "application/pdf": "PDF"
    default: "Text"
    }
  }

  var available: Bool { status == "present" || status == "verified" }

  var statusText: String? {
    switch status {
    case "present", "verified": nil
    case "missing": "Missing: its saved copy is gone, so it can't be exported."
    default: "Corrupt: its saved copy no longer matches, so it can't be exported."
    }
  }
}

/// One page of a dot's Library. `next`, when there may be more, is where the next older page starts.
struct ArtifactPage: Decodable, Equatable {
  let artifacts: [Artifact]
  var next: Int? = nil
}

/// The Library pages the notch has read for one dot.
typealias LibraryState = NewestFirstPages<Artifact>

extension NewestFirstPages where Row == Artifact {
  mutating func apply(_ read: Read, _ page: ArtifactPage, older isOlder: Bool) {
    apply(read, rows: page.artifacts, next: page.next, older: isOlder)
  }
}

/// The name an export is offered under: the deliverable's own name without anything a file name
/// can't safely hold, such as a path separator, a colon, a control character or a leading dot.
func exportFilename(_ artifact: Artifact) -> String {
  let cleaned = String(String.UnicodeScalarView(artifact.name.unicodeScalars.map { scalar in
    scalar == "/" || scalar == ":" || scalar == "\\" || CharacterSet.controlCharacters.contains(scalar) ? "_" : scalar
  }))
  let trimmed = String(cleaned.drop { $0 == "." || $0.isWhitespace })
  return trimmed.isEmpty ? "deliverable-\(artifact.id)" : trimmed
}

/// True only when the bytes are exactly the deliverable the Library listed: its size and SHA-256.
func matchesArtifact(_ data: Data, _ artifact: Artifact) -> Bool {
  data.count == artifact.size
    && SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() == artifact.sha256
}

/// Answers every redirect with no request, so the redirect itself comes back as the response
/// and nothing, neither the token nor a body, is sent on to where it points.
final class NoRedirects: NSObject, URLSessionTaskDelegate, Sendable {
  func urlSession(
    _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest
  ) async -> URLRequest? {
    nil
  }
}

enum APIError: Error {
  case unreachable
  case lost
  case server(String)

  var message: String {
    switch self {
    case .unreachable: "open-dot daemon isn't running"
    case .lost: "No response from the open-dot daemon. It may still deliver the message."
    case .server(let text): text
    }
  }
}

@MainActor final class API {
  private struct Endpoint: Decodable {
    let url: String
    let token: String
  }

  private let file: URL
  private let session: URLSession
  private var endpoint: Endpoint?

  /// `file` and `protocols` are for tests: another api.json, and fake URL loading in place of a daemon.
  init(file: URL? = nil, protocols: [AnyClass] = []) {
    let home = ProcessInfo.processInfo.environment["OPEN_DOT_HOME"].map {
      URL(fileURLWithPath: NSString(string: $0).expandingTildeInPath)
    }
    self.file = file
      ?? (home ?? FileManager.default.homeDirectoryForCurrentUser.appending(path: ".opendot"))
        .appending(path: "api.json")
    // Every request carries the token, and some a Slack token, so none goes through a proxy or
    // follows a redirect.
    let configuration = URLSessionConfiguration.ephemeral
    configuration.connectionProxyDictionary = [:]
    configuration.protocolClasses = protocols + (configuration.protocolClasses ?? [])
    session = URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
  }

  /// The daemon's address from api.json, only as the daemon writes it: plain http to 127.0.0.1 or
  /// [::1] with a port, and nothing else, so the token never goes anywhere but this Mac's daemon.
  nonisolated static func loopback(_ address: String) -> URL? {
    guard let parts = URLComponents(string: address), parts.scheme == "http",
      let host = parts.percentEncodedHost, ["127.0.0.1", "::1", "[::1]"].contains(host),
      let port = parts.port, (1...65535).contains(port),
      parts.percentEncodedUser == nil, parts.percentEncodedPassword == nil,
      parts.percentEncodedPath.isEmpty, parts.percentEncodedQuery == nil,
      parts.percentEncodedFragment == nil
    else { return nil }
    return URL(string: address)
  }

  func dots() async throws -> [Dot] {
    try decode([Dot].self, await send("GET", "/dots"))
  }

  /// The conversation, where each of the owner's sends that isn't in it yet stands, and the owner's
  /// recent emoji for the menu's second row, which a daemon older than any-emoji Tapbacks omits.
  func messages(_ dot: String, before: String? = nil) async throws -> MessagePage {
    let query = before.map { "?before=\(escape($0))" } ?? ""
    return try decode(MessagePage.self, await send("GET", "/dots/\(escape(dot))/messages\(query)"))
  }

  func message(_ key: MessageKey, session: String) async throws -> Message {
    try decode(Message.self, await send("GET", "/dots/\(escape(key.dot))/messages/\(escape(key.message))?sessionID=\(escape(session))"))
  }

  /// Saves the owner's reaction, any single emoji or nil to remove it, and returns the second row as it now stands.
  func react(_ key: MessageKey, emoji: String?) async throws -> (reaction: Reaction, recent: [String]?) {
    struct Body: Decodable { let reaction: Reaction; let recentEmojis: [String]? }
    // JSONEncoder omits nil optional fields; removal needs an explicit JSON null.
    let body = try JSONSerialization.data(withJSONObject: ["emoji": emoji as Any? ?? NSNull()])
    let data = try await send("PUT", "/dots/\(escape(key.dot))/messages/\(escape(key.message))/reaction", body: body)
    guard let saved = try? decode(Body.self, data) else { throw APIError.lost }
    return (saved.reaction, saved.recentEmojis)
  }

  /// Hides the message in the notch only, for the session it was read from. Never retried on its own.
  func hide(_ key: MessageKey, session: String) async throws -> HiddenMarker {
    struct Body: Decodable { let hidden: HiddenMarker }
    let body = try JSONSerialization.data(withJSONObject: ["sessionID": session, "hidden": true] as [String: Any])
    let data = try await send("PUT", "/dots/\(escape(key.dot))/messages/\(escape(key.message))/hidden", body: body)
    guard let saved = try? decode(Body.self, data) else { throw APIError.lost }
    return saved.hidden
  }

  /// Steers a queued send into the dot's running turn, or cancels it. Never retried on its own.
  func changePending(_ dot: String, id: String, steer: Bool) async throws {
    let path = "/dots/\(escape(dot))/pending/\(escape(id))"
    if steer {
      let body = try JSONSerialization.data(withJSONObject: ["delivery": "steer"])
      _ = try await send("PATCH", path, body: body)
    } else {
      _ = try await send("DELETE", path)
    }
  }

  /// Queues the text, as a reply to a feed item when `feed` is its ID. Never retried on its own.
  func post(_ dot: String, text: String, feed: Int? = nil, replyTo: String? = nil, files: [ImageUpload] = []) async throws -> String {
    struct Request: Encodable { let text: String; let feed: Int?; let replyTo: String?; let files: [ImageUpload] }
    struct Body: Decodable { let id: String }
    let encoder = JSONEncoder()
    encoder.outputFormatting = .withoutEscapingSlashes
    let body = try encoder.encode(Request(text: text, feed: feed, replyTo: replyTo, files: files))
    return try decode(Body.self, await send("POST", "/dots/\(escape(dot))/messages", body: body)).id
  }

  /// An attachment's bytes, read through the daemon from the dot's own session, never from a URL.
  /// With a session, the daemon refuses with 409 unless the dot is bound to it before and after
  /// the read, so a rebinding can't hand back another session's bytes.
  func attachment(_ key: AttachmentKey, session: String? = nil) async throws -> Data {
    let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
    let pin = session.map { "?sessionID=\($0.addingPercentEncoding(withAllowedCharacters: unreserved) ?? $0)" } ?? ""
    return try await send("GET", "/dots/\(escape(key.dot))/messages/\(escape(key.message))/attachments/\(key.index)\(pin)")
  }

  /// The dot's avatar image, which the daemon reads only from its own avatar.png.
  func avatar(_ dot: String) async throws -> Data {
    try await send("GET", "/dots/\(escape(dot))/avatar")
  }

  func feed() async throws -> (items: [FeedItem], handedOff: [FeedItem], remaining: Int) {
    struct Body: Decodable { let items: [FeedItem]; let handedOff: [FeedItem]?; let remaining: Int? }
    let body = try decode(Body.self, await send("GET", "/feed"))
    return (body.items, body.handedOff ?? [], body.remaining ?? 0)
  }

  func dismissFeed(_ id: Int) async throws {
    _ = try await send("POST", "/feed/\(id)/dismiss")
  }

  /// Dismisses exactly these feed items in one request. Never retried on its own.
  func dismissFeed(_ ids: [Int]) async throws -> (dismissed: [Int], missing: [Int]) {
    struct Body: Decodable { let dismissed: [Int]; let missing: [Int] }
    let body = try JSONSerialization.data(withJSONObject: ["ids": ids])
    let result = try decode(Body.self, await send("POST", "/feed/dismiss", body: body))
    return (result.dismissed, result.missing)
  }

  func memory(_ dot: String) async throws -> Memory {
    try decode(Memory.self, await send("GET", "/dots/\(escape(dot))/memory"))
  }

  /// The dot's AGENTS.md, which the daemon reads only from that dot's own directory.
  func instructions(_ dot: String) async throws -> Instructions {
    try decode(Instructions.self, await send("GET", "/dots/\(escape(dot))/instructions"))
  }

  /// Replaces the dot's AGENTS.md if it's still at `revision`. Never retried on its own.
  func saveInstructions(_ dot: String, content: String, revision: String) async throws -> InstructionsOutcome {
    let body = try JSONSerialization.data(withJSONObject: ["content": content, "revision": revision])
    let (status, data) = try await exchange("PUT", "/dots/\(escape(dot))/instructions", body: body)
    return try instructionsOutcome(status: status, data: data)
  }

  /// Puts back the previous version if AGENTS.md is still at `revision`. Never retried on its own.
  func revertInstructions(_ dot: String, revision: String) async throws -> InstructionsOutcome {
    let body = try JSONSerialization.data(withJSONObject: ["revision": revision])
    let (status, data) = try await exchange("POST", "/dots/\(escape(dot))/instructions/revert", body: body)
    return try instructionsOutcome(status: status, data: data)
  }

  /// Opens a worker's session in a new terminal window, or copies its command. Never retried on its own.
  func openWorker(_ id: Int) async throws -> WorkerOpened {
    try decode(WorkerOpened.self, await send("POST", "/workers/\(id)/open"))
  }

  /// Opens a worker request's session, such as a Threads worker's. Never retried on its own.
  func openRequest(_ id: Int) async throws -> WorkerOpened {
    try decode(WorkerOpened.self, await send("POST", "/requests/\(id)/open"))
  }

  /// A page of the dot's worker requests and answers, newest first, older than `before` if given.
  func requests(_ dot: String, before: Int? = nil) async throws -> RequestAuditPage {
    let query = before.map { "?before=\($0)" } ?? ""
    return try decode(RequestAuditPage.self, await send("GET", "/dots/\(escape(dot))/requests\(query)"))
  }

  /// A page of the dot's Library, newest first, older than `before` if given. The daemon only reads.
  func library(_ dot: String, before: Int? = nil) async throws -> ArtifactPage {
    let query = before.map { "?before=\($0)" } ?? ""
    return try decode(ArtifactPage.self, await send("GET", "/dots/\(escape(dot))/library\(query)"))
  }

  /// A deliverable's bytes, by its ID in that dot's Library, never by a path. The daemon serves
  /// them only while they match the saved digest, and the notch checks them again.
  func artifactContent(_ dot: String, _ id: Int) async throws -> Data {
    try await send("GET", "/dots/\(escape(dot))/library/\(id)/content")
  }

  /// The daemon's health report, the same as `open-dot doctor --json`. It only reads.
  func health() async throws -> HealthReport {
    try decode(HealthReport.self, await send("GET", "/health"))
  }

  /// A page of a responsibility's scheduled runs, newest first, older than `before` if given. The daemon only reads.
  func runs(_ key: RunListKey, before: Int? = nil) async throws -> RunPage {
    let query = before.map { "?before=\($0)" } ?? ""
    return try decode(RunPage.self, await send("GET", "/dots/\(escape(key.dot))/memory/responsibilities/\(key.responsibility)/runs\(query)"))
  }

  /// Reads one message of a run's evidence through the pinned single-message route, which answers
  /// only while the dot is bound to `session`, before and after its read. It only reads, starts no
  /// turn, and is never retried on its own.
  func runEvidence(_ key: RunEvidenceKey, session: String) async throws -> RunEvidenceRead {
    let path = "/dots/\(escape(key.dot))/messages/\(escape(key.message))?sessionID=\(escape(session))"
    let (status, data) = try await exchange("GET", path)
    switch status {
    case 200: return .found(try decode(Message.self, data))
    case 404: return .gone
    case 409: return .elsewhere
    default:
      struct Failure: Decodable { let error: String }
      let text = (try? JSONDecoder().decode(Failure.self, from: data))?.error
      throw APIError.server(text ?? HTTPURLResponse.localizedString(forStatusCode: status))
    }
  }

  /// Stops a worker the owner confirmed. Never retried on its own.
  func stopWorker(_ id: Int) async throws -> Dot.Worker {
    struct Body: Decodable { let worker: Dot.Worker }
    return try decode(Body.self, await send("POST", "/workers/\(id)/stop")).worker
  }

  /// Approves a dot's request to supervise a session, or ends a binding. Never retried on its own.
  func changeSupervision(_ dot: String, _ id: Int, approve: Bool) async throws -> Supervision {
    struct Body: Decodable { let supervision: Supervision }
    let path = "/dots/\(escape(dot))/memory/supervisions/\(id)"
    let data = approve ? try await send("POST", "\(path)/approve") : try await send("DELETE", path)
    return try decode(Body.self, data).supervision
  }

  /// Saves a draft feed trigger, which runs nothing until the owner enables it. Never retried on its own.
  func createTrigger(_ dot: String, body: Data) async throws -> FeedTrigger {
    struct Body: Decodable { let trigger: FeedTrigger }
    return try decode(Body.self, await send("POST", "/dots/\(escape(dot))/memory/triggers", body: body)).trigger
  }

  /// The saved feed events a trigger matches. The daemon only reads.
  func previewTrigger(_ dot: String, _ id: Int) async throws -> TriggerPreview {
    try decode(TriggerPreview.self, await send("GET", "/dots/\(escape(dot))/memory/triggers/\(id)/preview"))
  }

  /// Enables or resumes a trigger at the revision the owner reviewed, pauses it or revokes it.
  /// Never retried on its own.
  func changeTrigger(_ dot: String, _ trigger: FeedTrigger, _ action: TriggerAction) async throws {
    let path = "/dots/\(escape(dot))/memory/triggers/\(trigger.id)"
    switch action {
    case .enable:
      let body = try JSONSerialization.data(withJSONObject: ["revision": trigger.revision])
      _ = try await send("POST", "\(path)/enable", body: body)
    case .pause: _ = try await send("POST", "\(path)/pause")
    case .revoke: _ = try await send("DELETE", path)
    }
  }

  /// The dot's saved notes that contain every word in `query`. Reads only open-dot's own notes.
  func searchNotes(_ dot: String, query: String) async throws -> NoteSearch {
    let words = query.addingPercentEncoding(withAllowedCharacters: Self.unreserved) ?? ""
    return try decode(NoteSearch.self, await send("GET", "/dots/\(escape(dot))/memory/search?q=\(words)"))
  }

  /// The message a note was saved from, which the daemon reads from the dot's exact bound
  /// conversation, checked before and after. Never retried on its own.
  /// The next older page of the dot's current observed rows. The daemon only reads.
  func observations(_ dot: String, before: Int) async throws -> ObservationPage {
    try decode(ObservationPage.self, await send("GET", "/dots/\(escape(dot))/memory/observations?before=\(before)"))
  }

  /// One of an observation's sources, from the daemon's archive. The daemon only reads.
  func observationSource(_ dot: String, observation: Int, message: String) async throws -> ObservationSourceRead {
    try decode(ObservationSourceRead.self, await send("GET", "/dots/\(escape(dot))/memory/observations/\(observation)/sources/\(escape(message))"))
  }

  func noteSource(_ dot: String, note: Int) async throws -> NoteSourceRead {
    try decode(NoteSourceRead.self, await send("GET", "/dots/\(escape(dot))/memory/notes/\(note)/source"))
  }

  private static let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

  /// Adds the owner's note. Never retried on its own.
  func addNote(_ dot: String, text: String) async throws -> MemoryNote {
    struct Body: Decodable { let note: MemoryNote }
    let body = try JSONSerialization.data(withJSONObject: ["text": text])
    return try decode(Body.self, await send("POST", "/dots/\(escape(dot))/memory/notes", body: body)).note
  }

  /// Changes one item, with a JSON body that names the version the owner saw, or deletes or cancels
  /// it at that version when `body` is nil. Never retried on its own.
  func changeMemory(_ dot: String, _ key: MemoryKey, version: Int, body: Data?) async throws -> MemoryOutcome {
    let path = "/dots/\(escape(dot))/memory/\(key.kind.rawValue)/\(key.id)"
    let status: Int
    let data: Data
    if let body {
      (status, data) = try await exchange("PATCH", path, body: body)
    } else {
      (status, data) = try await exchange("DELETE", "\(path)?version=\(version)")
    }
    struct Failure: Decodable { let error: String }
    let message = (try? JSONDecoder().decode(Failure.self, from: data))?.error ?? HTTPURLResponse.localizedString(forStatusCode: status)
    switch status {
    case 204 where body == nil: return .deleted
    case 200 where body != nil: return .saved(try item(key, data, conflict: false))
    case 409: return .conflict(try item(key, data, conflict: true), message)
    case 404: return .gone(message)
    default: throw APIError.server(message)
    }
  }

  /// The saved item, or a conflict's current value, which must be the item that was changed.
  private func item(_ key: MemoryKey, _ data: Data, conflict: Bool) throws -> MemoryItem {
    struct Notes: Decodable { let note: MemoryNote?; let current: MemoryNote? }
    struct Responsibilities: Decodable { let responsibility: MemoryResponsibility?; let current: MemoryResponsibility? }
    struct Reminders: Decodable { let reminder: MemoryReminder?; let current: MemoryReminder? }
    struct Observations: Decodable { let observation: MemoryObservation?; let current: MemoryObservation? }
    let decoder = JSONDecoder()
    let item: MemoryItem?
    switch key.kind {
    case .note:
      let body = try? decoder.decode(Notes.self, from: data)
      item = (conflict ? body?.current : body?.note).map(MemoryItem.note)
    case .responsibility:
      let body = try? decoder.decode(Responsibilities.self, from: data)
      item = (conflict ? body?.current : body?.responsibility).map(MemoryItem.responsibility)
    case .reminder:
      let body = try? decoder.decode(Reminders.self, from: data)
      item = (conflict ? body?.current : body?.reminder).map(MemoryItem.reminder)
    case .observation:
      let body = try? decoder.decode(Observations.self, from: data)
      item = (conflict ? body?.current : body?.observation).map(MemoryItem.observation)
    }
    guard let item, item.key == key else { throw APIError.server("Unexpected response from the open-dot daemon") }
    return item
  }

  /// The dot's Slack app, as `open-dot slack status` shows it. Never a token.
  func slack(_ dot: String) async throws -> SlackSetup {
    try decode(SlackSetup.self, await send("GET", "/dots/\(escape(dot))/slack"))
  }

  /// Sends one Slack action. A token goes only in this request's body, to the daemon, which saves
  /// it in the Keychain; no answer repeats it. A manifest update rotates a token and calls Slack
  /// twice, so it may take up to a minute.
  func slackAction(_ dot: String, _ action: SlackAction) async throws -> SlackOutcome {
    let path = "/dots/\(escape(dot))/slack"
    switch action {
    case .config(let token, let refreshToken):
      let body = try JSONSerialization.data(withJSONObject: ["token": token, "refreshToken": refreshToken])
      _ = try await send("POST", "/slack/config", body: body)
      return .saved
    case .connect(let retry):
      let body = try JSONSerialization.data(withJSONObject: ["retry": retry])
      return .view(try decode(SlackSetup.self, await send("POST", "\(path)/connect", body: body)))
    case .attach(let appID):
      let body = try JSONSerialization.data(withJSONObject: ["appID": appID])
      return .view(try decode(SlackSetup.self, await send("POST", "\(path)/attach", body: body)))
    case .token(let kind, let token):
      let body = try JSONSerialization.data(withJSONObject: ["kind": kind, "token": token])
      return .view(try decode(SlackSetup.self, await send("POST", "\(path)/tokens", body: body)))
    case .update(let approve):
      struct Answer: Decodable { let said: String; let confirm: [String]? }
      var object: [String: Any] = [:]
      if let approve { object["approve"] = approve }
      let body = try JSONSerialization.data(withJSONObject: object)
      let answer = try decode(Answer.self, await send("POST", "\(path)/update", body: body, timeout: 90))
      if let changes = answer.confirm { return .confirm(changes) }
      return .said(answer.said)
    case .icon:
      return .view(try decode(SlackSetup.self, await send("POST", "\(path)/icon")))
    case .dmCheck:
      return .view(try decode(SlackSetup.self, await send("POST", "\(path)/dm-check")))
    case .loginStart:
      return .ticket(try decode(SlackLoginTicket.self, await send("POST", "/slack/login", timeout: 30)))
    case .loginFinish(let attempt, let challenge):
      let body = try JSONSerialization.data(withJSONObject: ["challenge": challenge])
      _ = try await send("POST", "/slack/login/\(escape(attempt))", body: body, timeout: 30)
      return .said("Logged in to Slack.")
    case .install:
      return .view(try decode(SlackSetup.self, await send("POST", "\(path)/install")))
    case .link(let bot, let app, let replacing):
      var object = ["bot": bot, "app": app]
      if let replacing { object["replaceAppID"] = replacing }
      let body = try JSONSerialization.data(withJSONObject: object)
      return .view(try decode(SlackSetup.self, await send("POST", "\(path)/link", body: body, timeout: 30)))
    }
  }

  // The daemon picks a new port and token on every start, so a failed connection or a 401
  // drops the cached endpoint and the next request reads api.json again.
  private func send(_ method: String, _ path: String, body: Data? = nil, timeout: TimeInterval = 10) async throws -> Data {
    let (status, data) = try await exchange(method, path, body: body, timeout: timeout)
    guard (200..<300).contains(status) else {
      struct Failure: Decodable { let error: String }
      let text = (try? JSONDecoder().decode(Failure.self, from: data))?.error
      throw APIError.server(text ?? HTTPURLResponse.localizedString(forStatusCode: status))
    }
    return data
  }

  private func exchange(_ method: String, _ path: String, body: Data? = nil, timeout: TimeInterval = 10) async throws -> (Int, Data) {
    guard let endpoint = endpoint ?? load(), Self.loopback(endpoint.url) != nil,
      let url = URL(string: endpoint.url + path)
    else {
      throw APIError.unreachable
    }
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
    request.httpMethod = method
    request.setValue("Bearer \(endpoint.token)", forHTTPHeaderField: "Authorization")
    if let body {
      request.httpBody = body
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: request)
    } catch let error as URLError where error.code == .timedOut || error.code == .networkConnectionLost {
      self.endpoint = nil
      throw APIError.lost
    } catch {
      self.endpoint = nil
      throw APIError.unreachable
    }
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    if status == 401 { self.endpoint = nil }
    // The daemon never redirects, so an answer that tries is no daemon's.
    if (300..<400).contains(status) {
      self.endpoint = nil
      throw APIError.unreachable
    }
    return (status, data)
  }

  /// Reads api.json, keeping it only when its address is the loopback daemon's.
  private func load() -> Endpoint? {
    let read = try? JSONDecoder().decode(Endpoint.self, from: Data(contentsOf: file))
    endpoint = read.flatMap { Self.loopback($0.url) == nil ? nil : $0 }
    return endpoint
  }

  private func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
    try Self.decode(type, data)
  }

  /// Decodes a daemon answer. A failure is logged with only the type, the field path and the kind of
  /// failure, never a value, since answers carry message text.
  nonisolated static func decode<T: Decodable>(_ type: T.Type, _ data: Data, log: (String) -> Void = API.log) throws -> T {
    do {
      return try JSONDecoder().decode(type, from: data)
    } catch let error as DecodingError {
      log("open-dot-notch: couldn't decode \(T.self) at \(fieldPath(error))")
      throw APIError.server("Unexpected response from the open-dot daemon")
    } catch {
      log("open-dot-notch: couldn't decode \(T.self)")
      throw APIError.server("Unexpected response from the open-dot daemon")
    }
  }

  /// Where and how decoding failed, such as `messages[2].time (typeMismatch)`. A debug description
  /// can quote the value, so it's left out.
  nonisolated static func fieldPath(_ error: DecodingError) -> String {
    let found: (path: [any CodingKey], kind: String) = switch error {
    case .typeMismatch(_, let context): (context.codingPath, "typeMismatch")
    case .valueNotFound(_, let context): (context.codingPath, "valueNotFound")
    case .keyNotFound(let key, let context): (context.codingPath + [key], "keyNotFound")
    case .dataCorrupted(let context): (context.codingPath, "dataCorrupted")
    @unknown default: ([], "unknown")
    }
    var text = ""
    for key in found.path {
      if let index = key.intValue { text += "[\(index)]" } else { text += text.isEmpty ? key.stringValue : ".\(key.stringValue)" }
    }
    return "\(text.isEmpty ? "<root>" : text) (\(found.kind))"
  }

  /// To stderr, which launchd writes to notch.log.
  nonisolated static func log(_ line: String) {
    FileHandle.standardError.write(Data("\(Date().ISO8601Format()) \(line)\n".utf8))
  }

  private func escape(_ name: String) -> String {
    name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? name
  }
}
