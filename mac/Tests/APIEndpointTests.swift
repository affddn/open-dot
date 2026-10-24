import Foundation
import XCTest
@testable import open_dot_notch

/// The daemon client's address check and its refusal to follow redirects, against fake URL loading
/// in process, with no network and no daemon.
final class APIEndpointTests: XCTestCase {
  func testOnlyThePlainLoopbackDaemonAddressIsUsed() {
    for good in ["http://127.0.0.1:4567", "http://[::1]:4567"] {
      XCTAssertNotNil(API.loopback(good), good)
    }
    for bad in [
      "", "https://127.0.0.1:4567", "ftp://127.0.0.1:4567", "http://evil.example:4567", "http://localhost:4567",
      "http://127.0.0.1", "http://127.0.0.1:4567/", "http://127.0.0.1:4567/base", "http://user:pw@127.0.0.1:4567",
      "http://127.0.0.1:4567@evil.example", "http://127.0.0.1:4567?x=1", "http://127.0.0.1:4567#f",
      "http://127.0.0.%31:4567", "http://127.0.0.1.evil.example:4567",
    ] {
      XCTAssertNil(API.loopback(bad), bad)
    }
  }

  @MainActor func testARemoteAddressGetsNoRequestSoNoTokenLeaves() async throws {
    FakeDaemon.seen.reset()
    let api = API(file: try endpointFile("http://evil.example:4567"), protocols: [FakeDaemon.self])
    do {
      _ = try await api.slackAction("jojo", .token(kind: "bot", token: "xoxb-test"))
      XCTFail("A token was sent to a remote address")
    } catch {
      XCTAssertEqual((error as? APIError)?.message, APIError.unreachable.message)
    }
    do {
      _ = try await api.slack("jojo")
      XCTFail("A read went to a remote address")
    } catch {
      XCTAssertEqual((error as? APIError)?.message, APIError.unreachable.message)
    }
    XCTAssertEqual(FakeDaemon.seen.all, [])
  }

  @MainActor func testARedirectIsNeverFollowedSoNeitherTokenNorBodyGoesOn() async throws {
    FakeDaemon.seen.reset()
    let api = API(file: try endpointFile("http://127.0.0.1:4567"), protocols: [FakeDaemon.self])
    let read = try await api.slack("jojo")
    XCTAssertNil(read.app)
    do {
      _ = try await api.slackAction("jojo", .token(kind: "bot", token: "xoxb-test"))
      XCTFail("A redirected answer was taken as the daemon's")
    } catch {}
    XCTAssertEqual(
      FakeDaemon.seen.all,
      ["http://127.0.0.1:4567/dots/jojo/slack", "http://127.0.0.1:4567/dots/jojo/slack/tokens"],
      "Nothing reached the redirect's target")
  }
}

/// Issue 50's actions reach only their own daemon routes, each once.
final class SlackLoginRouteTests: XCTestCase {
  @MainActor func testTheLoginInstallAndLinkActionsUseTheirRoutes() async throws {
    FakeDaemon.seen.reset()
    FakeDaemon.requests.reset()
    defer { FakeDaemon.loginAnswer = Data(#"{"config":{"state":"idle"},"app":null}"#.utf8) }
    let api = API(file: try endpointFile("http://127.0.0.1:4567"), protocols: [FakeDaemon.self])
    _ = try await api.slackAction("jojo", .install)
    _ = try await api.slackAction("jojo", .link(bot: "xoxb-test", app: "xapp-test", replacing: nil))
    _ = try await api.slackAction("jojo", .link(bot: "xoxb-test", app: "xapp-test", replacing: "AJOJO01"))
    _ = try await api.slackAction("jojo", .connect(retry: true))
    let finished = try await api.slackAction("jojo", .loginFinish(attempt: "a/../b", challenge: "C1"))
    XCTAssertEqual(finished, .said("Logged in to Slack."))
    // A Slack state, or a ticket missing a field, is never taken as a login's ticket.
    for answer in [#"{"config":{"state":"idle"},"app":null}"#, #"{"attempt":"a1","command":"/slackauthticket T"}"#,
                   #"{"attempt":1,"command":"/slackauthticket T","expiresAt":2}"#] {
      FakeDaemon.loginAnswer = Data(answer.utf8)
      do {
        _ = try await api.slackAction("jojo", .loginStart)
        XCTFail("Taken as a ticket: \(answer)")
      } catch {}
    }
    FakeDaemon.loginAnswer = Data(#"{"attempt":"a1","command":"/slackauthticket TICKET","expiresAt":1800000000000}"#.utf8)
    let started = try await api.slackAction("jojo", .loginStart)
    XCTAssertEqual(started, .ticket(SlackLoginTicket(attempt: "a1", command: "/slackauthticket TICKET", expiresAt: 1_800_000_000_000)))
    XCTAssertEqual(FakeDaemon.seen.all, [
      "http://127.0.0.1:4567/dots/jojo/slack/install",
      "http://127.0.0.1:4567/dots/jojo/slack/link",
      "http://127.0.0.1:4567/dots/jojo/slack/link",
      "http://127.0.0.1:4567/dots/jojo/slack/connect",
      "http://127.0.0.1:4567/slack/login/a%2F..%2Fb",
      "http://127.0.0.1:4567/slack/login",
      "http://127.0.0.1:4567/slack/login",
      "http://127.0.0.1:4567/slack/login",
      "http://127.0.0.1:4567/slack/login",
    ])
    // Each with its method, the daemon's token and exactly its body; a start and an install send none.
    let sent = FakeDaemon.requests.all.map { line -> (String, String, [String: AnyHashable]?) in
      let parts = line.components(separatedBy: " | ")
      let body = parts[2].isEmpty ? nil : (try? JSONSerialization.jsonObject(with: Data(parts[2].utf8))) as? [String: AnyHashable]
      return (parts[0], parts[1], body)
    }
    XCTAssertTrue(sent.allSatisfy { $0.1 == "Bearer test-token" })
    XCTAssertEqual(sent.map(\.0), [
      "POST /dots/jojo/slack/install", "POST /dots/jojo/slack/link", "POST /dots/jojo/slack/link",
      "POST /dots/jojo/slack/connect", "POST /slack/login/a/../b",
      "POST /slack/login", "POST /slack/login", "POST /slack/login", "POST /slack/login",
    ])
    XCTAssertEqual(sent.map(\.2), [
      nil,
      // No replacement sends no field at all, and one sends the exact app ID confirmed.
      ["bot": "xoxb-test", "app": "xapp-test"],
      ["bot": "xoxb-test", "app": "xapp-test", "replaceAppID": "AJOJO01"],
      ["retry": true],
      ["challenge": "C1"],
      nil, nil, nil, nil,
    ])
  }
}

/// The URLs a fake daemon was asked for, from whatever thread URL loading uses.
final class SeenURLs: @unchecked Sendable {
  private let lock = NSLock()
  private var urls: [String] = []

  func add(_ url: String) {
    lock.lock()
    urls.append(url)
    lock.unlock()
  }

  func reset() {
    lock.lock()
    urls = []
    lock.unlock()
  }

  var all: [String] {
    lock.lock()
    defer { lock.unlock() }
    return urls
  }
}

/// A daemon in process. It records every request; the token save is answered with a redirect to
/// another host, as a hostile endpoint would, and everything else with an empty Slack state.
final class FakeDaemon: URLProtocol {
  static let seen = SeenURLs()
  /// Each request as `METHOD path | authorization | body`, and what `POST /slack/login` answers.
  static let requests = SeenURLs()
  nonisolated(unsafe) static var loginAnswer = Data(#"{"config":{"state":"idle"},"app":null}"#.utf8)

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    guard let url = request.url, let client else { return }
    Self.seen.add(url.absoluteString)
    Self.requests.add("\(request.httpMethod ?? "") \(url.path) | \(request.value(forHTTPHeaderField: "Authorization") ?? "-") | \(String(decoding: Self.body(request), as: UTF8.self))")
    if url.path == "/dots/jojo/slack/tokens", let target = URL(string: "http://elsewhere.invalid/steal"),
      let moved = HTTPURLResponse(url: url, statusCode: 307, httpVersion: "HTTP/1.1", headerFields: ["Location": target.absoluteString])
    {
      var next = URLRequest(url: target)
      next.httpMethod = request.httpMethod
      client.urlProtocol(self, wasRedirectedTo: next, redirectResponse: moved)
      client.urlProtocol(self, didReceive: moved, cacheStoragePolicy: .notAllowed)
      client.urlProtocolDidFinishLoading(self)
      return
    }
    guard let ok = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"]) else { return }
    client.urlProtocol(self, didReceive: ok, cacheStoragePolicy: .notAllowed)
    let answer = url.path == "/slack/login" ? Self.loginAnswer : Data(#"{"config":{"state":"idle"},"app":null}"#.utf8)
    client.urlProtocol(self, didLoad: answer)
    client.urlProtocolDidFinishLoading(self)
  }

  /// A request's body, which URL loading hands a protocol as a stream.
  private static func body(_ request: URLRequest) -> Data {
    if let body = request.httpBody { return body }
    guard let stream = request.httpBodyStream else { return Data() }
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while stream.hasBytesAvailable {
      let count = stream.read(&buffer, maxLength: buffer.count)
      if count <= 0 { break }
      data.append(buffer, count: count)
    }
    return data
  }

  override func stopLoading() {}
}

/// An api.json holding `url`, in a fresh temporary file.
private func endpointFile(_ url: String) throws -> URL {
  let file = FileManager.default.temporaryDirectory.appending(path: "open-dot-api-\(UUID().uuidString).json")
  try JSONSerialization.data(withJSONObject: ["url": url, "token": "test-token"]).write(to: file)
  return file
}
