import Foundation

struct Dot: Decodable, Equatable {
  struct Worker: Decodable, Equatable {
    let id: Int
    let state: String
    let task: String
  }

  let name: String
  let purpose: String?
  let busy: Bool
  let workers: [Worker]
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
  func messages(_ dot: String) async throws -> (messages: [Message], pending: [String: String], recent: [String]?) {
    struct Status: Decodable { let id: String; let status: String }
    struct Body: Decodable { let messages: [Message]; let pending: [Status]?; let recentEmojis: [String]? }
    let body = try decode(Body.self, await send("GET", "/dots/\(escape(dot))/messages"))
    return (body.messages, Dictionary((body.pending ?? []).map { ($0.id, $0.status) }) { first, _ in first }, body.recentEmojis)
  }

  /// Saves the owner's reaction, any single emoji or nil to remove it, and returns the second row as it now stands.
  func react(_ key: MessageKey, emoji: String?) async throws -> (reaction: Reaction, recent: [String]?) {
    struct Body: Decodable { let reaction: Reaction; let recentEmojis: [String]? }
    // JSONEncoder omits nil optional fields; removal needs an explicit JSON null.
    let body = try JSONSerialization.data(withJSONObject: ["emoji": emoji as Any? ?? NSNull()])
    let saved = try decode(Body.self, await send("PUT", "/dots/\(escape(key.dot))/messages/\(escape(key.message))/reaction", body: body))
    return (saved.reaction, saved.recentEmojis)
  }

  /// Hides the message in the notch only, for the session it was read from. Never retried on its own.
  func hide(_ key: MessageKey, session: String) async throws -> HiddenMarker {
    struct Body: Decodable { let hidden: HiddenMarker }
    let body = try JSONSerialization.data(withJSONObject: ["sessionID": session, "hidden": true] as [String: Any])
    return try decode(Body.self, await send("PUT", "/dots/\(escape(key.dot))/messages/\(escape(key.message))/hidden", body: body)).hidden
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

  func feed() async throws -> (items: [FeedItem], handedOff: [FeedItem]) {
    struct Body: Decodable { let items: [FeedItem]; let handedOff: [FeedItem]? }
    let body = try decode(Body.self, await send("GET", "/feed"))
    return (body.items, body.handedOff ?? [])
  }

  func dismissFeed(_ id: Int) async throws {
    _ = try await send("POST", "/feed/\(id)/dismiss")
  }

  // The daemon picks a new port and token on every start, so a failed connection or a 401
  // drops the cached endpoint and the next request reads api.json again.
  private func send(_ method: String, _ path: String, body: Data? = nil) async throws -> Data {
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
    guard (200..<300).contains(status) else {
      struct Failure: Decodable { let error: String }
      let text = (try? JSONDecoder().decode(Failure.self, from: data))?.error
      throw APIError.server(text ?? HTTPURLResponse.localizedString(forStatusCode: status))
    }
    return data
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
