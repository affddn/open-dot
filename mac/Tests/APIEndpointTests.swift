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

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    guard let url = request.url, let client else { return }
    Self.seen.add(url.absoluteString)
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
    client.urlProtocol(self, didLoad: Data(#"{"config":{"state":"idle"},"app":null}"#.utf8))
    client.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}
}

/// An api.json holding `url`, in a fresh temporary file.
private func endpointFile(_ url: String) throws -> URL {
  let file = FileManager.default.temporaryDirectory.appending(path: "open-dot-api-\(UUID().uuidString).json")
  try JSONSerialization.data(withJSONObject: ["url": url, "token": "test-token"]).write(to: file)
  return file
}
