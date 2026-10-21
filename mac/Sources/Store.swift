import AppKit
import ImageIO
import Observation

struct Pending: Identifiable {
  let id = UUID()
  let text: String
  let sentAt = Date().timeIntervalSince1970 * 1000
  /// The feed item it replies to.
  var feed: FeedItem?
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
  var handedOff: [FeedItem] = []
  /// The feed item being replied to, the dots it goes to in the order picked, and the prompt.
  var replying: FeedItem?
  var replyDots: [String] = []
  var replyDraft = ""
  var feedErrors: [Int: String] = [:]
  var feedStatus: String?
  var showingFeed = false
  var thumbnails: [AttachmentKey: NSImage] = [:]
  var unavailable: Set<AttachmentKey> = []
  var reacting: Set<ReactionKey> = []
  var reactionErrors: [ReactionKey: String] = [:]
  @ObservationIgnored private var reactionEpoch: [String: Int] = [:]
  @ObservationIgnored private var messageReads: [String: Int] = [:]
  private var seen: [String: Double] = [:]
  private var newest: [String: Double] = [:]
  private var feedSeen: Double?
  private var feedNewest: Double = 0
  @ObservationIgnored private var dismissing: Set<Int> = []
  @ObservationIgnored private var dismissed: Set<Int> = []
  @ObservationIgnored private var loading: Set<AttachmentKey> = []
  @ObservationIgnored private var opening: Set<AttachmentKey> = []
  @ObservationIgnored private let api = API()

  var showsIndicator: Bool { dotsBusy || dotsUnread || feedUnread }

  // The dot list goes stale while OpenCode is down, so it lights nothing then.
  var dotsBusy: Bool { status == nil && dots.contains(where: \.busy) }

  var dotsUnread: Bool { status == nil && dots.contains { unread($0.name) } }

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

  static let startPrompt = "Take this on. Work out what it needs and get it done, delegating a worker or tracking it as a responsibility if it's more than a quick answer. Tell me what you decide."
  static let contextPrompt = "Keep this in mind as context. Tell me briefly what it means for what we're working on."

  /// Opens the reply box, with the dot last chatted with picked.
  func startReply(_ item: FeedItem) {
    if replying?.id != item.id { replyDraft = "" }
    replying = item
    replyDots = (selected ?? dots.first?.name).map { [$0] } ?? []
  }

  func toggleReplyDot(_ name: String) {
    if let index = replyDots.firstIndex(of: name) { replyDots.remove(at: index) } else { replyDots.append(name) }
  }

  func cancelReply() {
    replying = nil
  }

  /// Sends the prompt and item to each picked dot once, then opens the first one's chat. Each send
  /// shows as a pending message in its dot's chat. A failed or unknown one keeps its prompt there
  /// and is named under the item, and is never sent again on its own.
  func sendReply() {
    guard let item = replying else { return }
    let text = replyDraft.trimmingCharacters(in: .whitespacesAndNewlines)
    let targets = replyDots
    guard !text.isEmpty, let first = targets.first else { return }
    replying = nil
    replyDraft = ""
    feedErrors[item.id] = nil
    for dot in targets {
      let pendingItem = Pending(text: text, feed: item)
      pending[dot, default: []].append(pendingItem)
      Task {
        do {
          let id = try await api.post(dot, text: text, feed: item.id)
          update(dot, pendingItem.id) { $0.messageID = id }
        } catch {
          let message = Self.describe(error)
          update(dot, pendingItem.id) { $0.error = message }
          let note = "\(dot): \(message)"
          feedErrors[item.id] = feedErrors[item.id].map { "\($0) · \(note)" } ?? note
        }
        await refreshFeed()
      }
    }
    select(first)
  }

  func dismiss(_ name: String, _ id: UUID) {
    pending[name]?.removeAll { $0.id == id }
  }

  func react(_ key: ReactionKey, emoji: String) {
    guard let message = messages[key.dot]?.first(where: { $0.id == key.message }),
      message.kind == "dot", reacting.insert(key).inserted else { return }
    let selected = message.reactions?.first(where: { $0.actor == "owner" })?.emoji
    let next = selected == emoji ? nil : emoji
    reactionEpoch[key.dot, default: 0] += 1
    reactionErrors[key] = nil
    Task {
      defer {
        reacting.remove(key)
        reactionEpoch[key.dot, default: 0] += 1
      }
      do {
        let confirmed = try await api.react(key, emoji: next)
        guard confirmed.dot == key.dot, confirmed.messageID == key.message,
          confirmed.actor == "owner", confirmed.emoji == next else {
          reactionErrors[key] = "Reaction outcome unknown: unexpected response. Refreshing saved state."
          return
        }
        if let index = messages[key.dot]?.firstIndex(where: { $0.id == key.message }) {
          var saved = messages[key.dot]![index].reactions ?? []
          saved.removeAll { $0.actor == "owner" }
          saved.append(confirmed)
          messages[key.dot]![index].reactions = saved
        }
      } catch {
        if let failure = error as? APIError, case .lost = failure {
          reactionErrors[key] = "Reaction outcome unknown: no response. It may have been saved. No automatic retry."
        } else {
          reactionErrors[key] = "Reaction not confirmed. \(Self.describe(error)) Showing the last saved state; no automatic retry."
        }
      }
    }
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

  /// Loads an image attachment's thumbnail once, when its message is shown.
  func loadThumbnail(_ key: AttachmentKey) {
    guard thumbnails[key] == nil, !unavailable.contains(key), loading.insert(key).inserted else { return }
    Task {
      defer { loading.remove(key) }
      if let data = try? await api.attachment(key), let image = Self.decode(data, maxPixels: 240) {
        thumbnails[key] = image
      } else {
        unavailable.insert(key)
      }
    }
  }

  /// Clears a failed load, so clicking its chip tries again.
  func retryThumbnail(_ key: AttachmentKey) {
    unavailable.remove(key)
    loadThumbnail(key)
  }

  /// Reads the image again at full size, so only thumbnails stay in memory. A failure turns the
  /// thumbnail into a chip that can retry.
  func openImage(_ key: AttachmentKey, title: String) {
    guard opening.insert(key).inserted else { return }
    Task {
      defer { opening.remove(key) }
      if let data = try? await api.attachment(key), let image = Self.decode(data, maxPixels: nil) {
        ImageWindow.show(image, title: title)
      } else {
        thumbnails[key] = nil
        unavailable.insert(key)
      }
    }
  }

  /// Decodes only PNG, JPEG, GIF and WebP, whatever the bytes claim to be, and only up to 40
  /// million pixels, read from the header first, so a small file can't expand into a huge bitmap.
  private static func decode(_ data: Data, maxPixels: Int?) -> NSImage? {
    let allowed: Set<String> = ["public.png", "public.jpeg", "com.compuserve.gif", "org.webmproject.webp"]
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
      let type = CGImageSourceGetType(source) as String?, allowed.contains(type),
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
      let width = properties[kCGImagePropertyPixelWidth] as? Int,
      let height = properties[kCGImagePropertyPixelHeight] as? Int,
      width > 0, height > 0, width <= 40_000_000 / height else { return nil }
    // The thumbnail API at full size too, so both apply the photo's orientation.
    let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: maxPixels ?? max(width, height),
    ] as CFDictionary)
    return image.map { NSImage(cgImage: $0, size: .zero) }
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
    let items: [FeedItem]
    do {
      let result = try await api.feed()
      items = result.items
      handedOff = result.handedOff
    } catch {
      feedStatus = Self.describe(error)
      return
    }
    feedStatus = nil
    dismissing.subtract(settled)
    dismissed.subtract(settled)
    feed = items.filter { !dismissing.contains($0.id) }
    feedNewest = feed.map(\.time).max() ?? 0
    if feedSeen == nil || (expanded && showingFeed) { feedSeen = feedNewest }
  }

  private func refreshMessages(_ name: String) async {
    let epoch = reactionEpoch[name, default: 0]
    messageReads[name, default: 0] += 1
    let read = messageReads[name]
    guard let list = try? await api.messages(name) else { return }
    // Discard polls begun before/during a write, and older overlapping reads.
    guard epoch == reactionEpoch[name, default: 0], read == messageReads[name],
      !reacting.contains(where: { $0.dot == name }) else { return }
    messages[name] = list
    let ids = Set(list.map(\.id))
    // Forget images of messages that have scrolled out, but write only when something goes.
    let gone = { (key: AttachmentKey) in key.dot == name && !ids.contains(key.message) }
    if thumbnails.keys.contains(where: gone) { thumbnails = thumbnails.filter { !gone($0.key) } }
    if unavailable.contains(where: gone) { unavailable = unavailable.filter { !gone($0) } }
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
