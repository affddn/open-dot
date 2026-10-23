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

/// The audit pages the notch has read for one dot. A read applies only to rows no later read
/// already set, so a slow refresh can't bring back an older state, and older pages stay loaded.
struct RequestAuditState: Equatable {
  private var byID: [Int: RequestAudit] = [:]
  private var readOf: [Int: Int] = [:]
  private var reads = 0
  /// Where the next older page starts, from the page that reached the oldest loaded row.
  private(set) var older: Int? = nil
  var loadingOlder = false

  /// Newest first.
  var rows: [RequestAudit] { byID.values.sorted { $0.id > $1.id } }

  mutating func startRead() -> Int {
    reads += 1
    return reads
  }

  mutating func apply(_ read: Int, _ page: RequestAuditPage, older isOlder: Bool) {
    let oldest = byID.keys.min()
    for row in page.requests where (readOf[row.id] ?? 0) < read {
      byID[row.id] = row
      readOf[row.id] = read
    }
    // The page that reaches past every row loaded so far says where the next older one starts.
    if let last = page.requests.last?.id, oldest == nil || last <= oldest! {
      older = page.next
    } else if isOlder && page.requests.isEmpty {
      older = nil
    } else if oldest == nil {
      older = page.next
    }
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
  struct Status: Decodable { let id: String; let status: String }
  var messages: [Message]
  let sessionID: String?
  let next: String?
  let pending: [Status]?
  let recentEmojis: [String]?
  var statuses: [String: String] {
    Dictionary((pending ?? []).map { ($0.id, $0.status) }) { first, _ in first }
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

struct Memory: Decodable, Equatable {
  var notes: [MemoryNote]
  var responsibilities: [MemoryResponsibility]
  var reminders: [MemoryReminder]
  /// Requested and active supervisions. Older daemons send none.
  var supervisions: [Supervision]? = nil
}

enum MemoryKind: String {
  case note = "notes"
  case responsibility = "responsibilities"
  case reminder = "reminders"
}

struct MemoryKey: Hashable {
  let kind: MemoryKind
  let id: Int
}

enum MemoryItem: Equatable {
  case note(MemoryNote)
  case responsibility(MemoryResponsibility)
  case reminder(MemoryReminder)

  var key: MemoryKey {
    switch self {
    case .note(let note): MemoryKey(kind: .note, id: note.id)
    case .responsibility(let item): MemoryKey(kind: .responsibility, id: item.id)
    case .reminder(let reminder): MemoryKey(kind: .reminder, id: reminder.id)
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
  private let session = URLSession(configuration: .ephemeral)
  private var endpoint: Endpoint?

  init() {
    let home = ProcessInfo.processInfo.environment["OPEN_DOT_HOME"].map {
      URL(fileURLWithPath: NSString(string: $0).expandingTildeInPath)
    }
    file = (home ?? FileManager.default.homeDirectoryForCurrentUser.appending(path: ".opendot"))
      .appending(path: "api.json")
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
    }
    guard let item, item.key == key else { throw APIError.server("Unexpected response from the open-dot daemon") }
    return item
  }

  // The daemon picks a new port and token on every start, so a failed connection or a 401
  // drops the cached endpoint and the next request reads api.json again.
  private func send(_ method: String, _ path: String, body: Data? = nil) async throws -> Data {
    let (status, data) = try await exchange(method, path, body: body)
    guard (200..<300).contains(status) else {
      struct Failure: Decodable { let error: String }
      let text = (try? JSONDecoder().decode(Failure.self, from: data))?.error
      throw APIError.server(text ?? HTTPURLResponse.localizedString(forStatusCode: status))
    }
    return data
  }

  private func exchange(_ method: String, _ path: String, body: Data? = nil) async throws -> (Int, Data) {
    guard let endpoint = endpoint ?? load(), let url = URL(string: endpoint.url + path) else {
      throw APIError.unreachable
    }
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
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
    return (status, data)
  }

  private func load() -> Endpoint? {
    endpoint = try? JSONDecoder().decode(Endpoint.self, from: Data(contentsOf: file))
    return endpoint
  }

  private func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
    do {
      return try JSONDecoder().decode(type, from: data)
    } catch {
      throw APIError.server("Unexpected response from the open-dot daemon")
    }
  }

  private func escape(_ name: String) -> String {
    name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? name
  }
}
