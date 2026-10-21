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
  let kind: String
  let peer: String?
  let text: String
  let tools: [String]?
  let attachments: [Attachment]?
  /// The feed item the owner replied to, as the daemon read it when the message was sent.
  let feed: FeedItem?
  let time: Double
}

struct AttachmentKey: Hashable {
  let dot: String
  let message: String
  let index: Int
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

  func messages(_ dot: String) async throws -> [Message] {
    struct Body: Decodable { let messages: [Message] }
    return try decode(Body.self, await send("GET", "/dots/\(escape(dot))/messages")).messages
  }

  /// Queues the text, as a reply to a feed item when `feed` is its ID. Never retried on its own.
  func post(_ dot: String, text: String, feed: Int? = nil) async throws -> String {
    struct Request: Encodable { let text: String; let feed: Int? }
    struct Body: Decodable { let id: String }
    let body = try JSONEncoder().encode(Request(text: text, feed: feed))
    return try decode(Body.self, await send("POST", "/dots/\(escape(dot))/messages", body: body)).id
  }

  /// An attachment's bytes, read through the daemon from the dot's own session, never from a URL.
  func attachment(_ key: AttachmentKey) async throws -> Data {
    try await send("GET", "/dots/\(escape(key.dot))/messages/\(escape(key.message))/attachments/\(key.index)")
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
