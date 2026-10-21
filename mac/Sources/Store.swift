import Foundation
import Observation

struct Pending: Identifiable {
  let id = UUID()
  let text: String
  let sentAt = Date().timeIntervalSince1970 * 1000
  var messageID: String?
  var error: String?
}

@MainActor @Observable final class Store {
  var dots: [Dot] = []
  var status: String?
  var loaded = false
  var selected: String?
  var messages: [String: [Message]] = [:]
  var pending: [String: [Pending]] = [:]
  var drafts: [String: String] = [:]
  var expanded = false
  var feed: [FeedItem] = []
  var feedErrors: [Int: String] = [:]
  var showingFeed = false
  private var seen: [String: Double] = [:]
  private var newest: [String: Double] = [:]
  private var feedSeen: Double?
  private var feedNewest: Double = 0
  @ObservationIgnored private var dismissing: Set<Int> = []
  @ObservationIgnored private var dismissed: Set<Int> = []
  @ObservationIgnored private let api = API()

  var showsIndicator: Bool { status == nil && (feedUnread || dots.contains { $0.busy || unread($0.name) }) }

  var feedUnread: Bool { feedNewest > (feedSeen ?? .infinity) }

  func unread(_ name: String) -> Bool { (newest[name] ?? 0) > (seen[name] ?? .infinity) }

  private func visible(_ name: String) -> Bool { expanded && !showingFeed && selected == name }

  func start() {
    Task {
      while true {
        await refreshDots()
        try? await Task.sleep(for: .seconds(expanded ? 1 : 2))
      }
    }
    Task {
      while true {
        if let name = selected, visible(name) { await refreshMessages(name) }
        try? await Task.sleep(for: .seconds(1))
      }
    }
    // The dot list carries no message times, so other dots' messages are swept slowly
    // to light the unread indicator.
    Task {
      while true {
        await refreshFeed()
        for dot in dots where !visible(dot.name) { await refreshMessages(dot.name) }
        try? await Task.sleep(for: .seconds(5))
      }
    }
  }

  func opened() {
    Task { await refreshDots() }
    Task { await refreshFeed() }
    if let name = selected { Task { await refreshMessages(name) } }
  }

  func select(_ name: String) {
    showingFeed = false
    selected = name
    seen[name] = newest[name]
    Task { await refreshMessages(name) }
  }

  func send() {
    guard let name = selected else { return }
    let text = (drafts[name] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    drafts[name] = nil
    let item = Pending(text: text)
    pending[name, default: []].append(item)
    Task {
      do {
        let id = try await api.post(name, text: text)
        update(name, item.id) { $0.messageID = id }
      } catch {
        update(name, item.id) { $0.error = Self.describe(error) }
      }
    }
  }

  func dismiss(_ name: String, _ id: UUID) {
    pending[name]?.removeAll { $0.id == id }
  }

  func openFeed() {
    showingFeed = true
    feedSeen = feedNewest
    Task { await refreshFeed() }
  }

  func dismissFeed(_ item: FeedItem) {
    dismissing.insert(item.id)
    feed.removeAll { $0.id == item.id }
    feedErrors[item.id] = nil
    Task {
      do {
        try await api.dismissFeed(item.id)
        dismissed.insert(item.id)
      } catch {
        dismissing.remove(item.id)
        if !feed.contains(where: { $0.id == item.id }) {
          feed.append(item)
          feed.sort { $0.time < $1.time }
        }
        feedErrors[item.id] = Self.describe(error)
      }
    }
  }

  func clearFeedError(_ id: Int) {
    feedErrors[id] = nil
  }

  private func refreshDots() async {
    do {
      let next = try await api.dots()
      let finished = dots.filter { old in old.busy && next.contains { $0.name == old.name && !$0.busy } }
      dots = next
      status = nil
      if !next.contains(where: { $0.name == selected }) { selected = next.first?.name }
      for dot in finished { Task { await refreshMessages(dot.name) } }
    } catch {
      status = Self.describe(error)
    }
    loaded = true
  }

  private func refreshFeed() async {
    // A dismissed item stays hidden until a poll that started after its dismiss succeeded,
    // so a poll already in flight can't bring it back.
    let settled = dismissed
    guard let items = try? await api.feed() else { return }
    dismissing.subtract(settled)
    dismissed.subtract(settled)
    feed = items.filter { !dismissing.contains($0.id) }
    feedNewest = feed.map(\.time).max() ?? 0
    if feedSeen == nil || (expanded && showingFeed) { feedSeen = feedNewest }
  }

  private func refreshMessages(_ name: String) async {
    guard let list = try? await api.messages(name) else { return }
    messages[name] = list
    let ids = Set(list.map(\.id))
    let oldest = list.first?.time ?? 0
    // An accepted message older than everything shown was delivered and has scrolled out.
    pending[name]?.removeAll { item in item.messageID.map { ids.contains($0) || oldest > item.sentAt } ?? false }
    let latest = list.filter { $0.kind != "owner" }.map(\.time).max() ?? 0
    newest[name] = latest
    if seen[name] == nil || visible(name) { seen[name] = latest }
  }

  private func update(_ name: String, _ id: UUID, _ change: (inout Pending) -> Void) {
    guard let index = pending[name]?.firstIndex(where: { $0.id == id }) else { return }
    change(&pending[name]![index])
  }

  private static func describe(_ error: Error) -> String {
    (error as? APIError)?.message ?? error.localizedDescription
  }
}
