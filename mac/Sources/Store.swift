import AppKit
import Darwin
import ImageIO
import Observation
import UniformTypeIdentifiers

struct ImagePreview: Identifiable {
  let id: UUID
  let name: String
  let image: NSImage
}

struct DraftImage: Identifiable {
  let id = UUID()
  let file: ImageUpload
  let thumbnail: NSImage

  var preview: ImagePreview { ImagePreview(id: id, name: file.name, image: thumbnail) }
}

struct Pending: Identifiable {
  let id = UUID()
  let text: String
  let sentAt = Date().timeIntervalSince1970 * 1000
  /// The feed item it replies to.
  var feed: FeedItem?
  var quote: MessageQuote?
  var images: [ImagePreview] = []
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
  var draftImages: [String: [DraftImage]] = [:]
  var imageErrors: [String: String] = [:]
  var replyTargets: [String: MessageQuote] = [:]
  var sending: Set<String> = []
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

  func send(_ name: String) {
    guard !sending.contains(name) else { return }
    let draft = drafts[name] ?? ""
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    let files = draftImages[name] ?? []
    guard !text.isEmpty || !files.isEmpty else { return }
    let quote = replyTargets[name]
    let item = Pending(text: text, quote: quote, images: files.map(\.preview))
    pending[name, default: []].append(item)
    sending.insert(name)
    Task {
      defer { sending.remove(name) }
      do {
        let id = try await api.post(name, text: text, replyTo: quote?.id, files: files.map(\.file))
        update(name, item.id) { $0.messageID = id }
        if (drafts[name] ?? "") == draft { drafts[name] = nil }
        if replyTargets[name] == quote { replyTargets[name] = nil }
        let sent = Set(files.map(\.id))
        draftImages[name]?.removeAll { sent.contains($0.id) }
      } catch {
        update(name, item.id) { $0.error = Self.describe(error) }
      }
    }
  }

  func pickImages(_ name: String) {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = false
    panel.allowsMultipleSelection = true
    panel.allowedContentTypes = [.image]
    panel.begin { [weak self] response in
      guard response == .OK else { return }
      Task { @MainActor in self?.addImageFiles(panel.urls, to: name) }
    }
  }

  func removeImage(_ id: UUID, from name: String) {
    draftImages[name]?.removeAll { $0.id == id }
    imageErrors[name] = nil
  }

  static let imagePasteboardTypes: [NSPasteboard.PasteboardType] = [
    .png, .tiff, NSPasteboard.PasteboardType("public.jpeg"),
    NSPasteboard.PasteboardType("com.compuserve.gif"),
    NSPasteboard.PasteboardType("org.webmproject.webp"),
  ]

  /// Paste and native file drops are consumed synchronously by their originating editor.
  func pasteImages(_ board: NSPasteboard, to name: String) -> Bool {
    for type in Self.imagePasteboardTypes {
      if board.availableType(from: [type]) != nil {
        imageErrors[name] = nil
        guard let data = board.data(forType: type) else {
          imageErrors[name] = "Couldn't read the pasted image."
          return true
        }
        addImage(data, filename: "Pasted image", to: name, allowTIFF: type == .tiff)
        return true
      }
    }
    if let urls = board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
      addImageFiles(urls, to: name)
      return true
    }
    return false
  }

  func addImageFiles(_ urls: [URL], to name: String) {
    imageErrors[name] = nil
    for url in urls {
      guard (draftImages[name]?.count ?? 0) < 5 else {
        imageErrors[name] = "Attach at most five images."
        break
      }
      guard url.isFileURL, url.host == nil || url.host == "" || url.host == "localhost" else {
        imageErrors[name] = "Choose a local image file."
        continue
      }
      let access = url.startAccessingSecurityScopedResource()
      defer { if access { url.stopAccessingSecurityScopedResource() } }
      let descriptor = open(url.path, O_RDONLY | O_NONBLOCK | O_NOFOLLOW)
      guard descriptor >= 0 else {
        imageErrors[name] = "Couldn't read the image file."
        continue
      }
      let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
      defer { try? handle.close() }
      var info = stat()
      guard fstat(descriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG else {
        imageErrors[name] = "Choose a regular image file."
        continue
      }
      guard info.st_size >= 0, info.st_size <= Int64(Self.imageLimit) else {
        imageErrors[name] = "Each image must be at most 10 MiB."
        continue
      }
      do {
        var data = Data()
        while data.count <= Self.imageLimit {
          let chunk = try handle.read(upToCount: min(64 * 1024, Self.imageLimit + 1 - data.count)) ?? Data()
          if chunk.isEmpty { break }
          data.append(chunk)
        }
        addImage(data, filename: url.lastPathComponent, to: name)
      } catch {
        imageErrors[name] = "Couldn't read the image file."
      }
    }
  }

  private static let imageLimit = 10 * 1024 * 1024

  private func addImage(_ input: Data, filename: String, to name: String, allowTIFF: Bool = false) {
    guard (draftImages[name]?.count ?? 0) < 5 else {
      imageErrors[name] = "Attach at most five images."
      return
    }
    guard input.count <= Self.imageLimit else {
      imageErrors[name] = "Each image must be at most 10 MiB."
      return
    }
    var data = input
    var displayName = filename
    if allowTIFF, let source = CGImageSourceCreateWithData(data as CFData, nil),
      CGImageSourceGetType(source) as String? == UTType.tiff.identifier {
      guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
        let width = properties[kCGImagePropertyPixelWidth] as? Int,
        let height = properties[kCGImagePropertyPixelHeight] as? Int,
        width > 0, height > 0, width <= 40_000_000 / height,
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        imageErrors[name] = "Image is unreadable or exceeds 40 million pixels."
        return
      }
      let converted = NSMutableData()
      guard let destination = CGImageDestinationCreateWithData(converted, UTType.png.identifier as CFString, 1, nil) else {
        imageErrors[name] = "Couldn't convert the pasted image."
        return
      }
      CGImageDestinationAddImage(destination, image, nil)
      guard CGImageDestinationFinalize(destination), converted.length <= Self.imageLimit else {
        imageErrors[name] = "Converted image exceeds 10 MiB."
        return
      }
      data = converted as Data
      displayName = "Pasted image.png"
    }
    let bytes = [UInt8](data.prefix(12))
    let mime: String
    if bytes.starts(with: [137, 80, 78, 71, 13, 10, 26, 10]) { mime = "image/png" }
    else if bytes.starts(with: [255, 216, 255]) { mime = "image/jpeg" }
    else if bytes.starts(with: Array("GIF87a".utf8)) || bytes.starts(with: Array("GIF89a".utf8)) { mime = "image/gif" }
    else if bytes.count >= 12, bytes.starts(with: Array("RIFF".utf8)), Array(bytes[8..<12]) == Array("WEBP".utf8) { mime = "image/webp" }
    else {
      imageErrors[name] = "Only PNG, JPEG, GIF and WebP images are supported."
      return
    }
    guard let thumbnail = Self.decode(data, maxPixels: 160) else {
      imageErrors[name] = "Image is unreadable or exceeds 40 million pixels."
      return
    }
    let safeName = String(displayName.unicodeScalars.filter {
      !CharacterSet.controlCharacters.contains($0) && $0 != "/" && $0 != "\\"
    }.prefix(120).map(String.init).joined())
    let file = ImageUpload(mime: mime, name: safeName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Image" : safeName, data: data)
    draftImages[name, default: []].append(DraftImage(file: file, thumbnail: thumbnail))
  }

  func reply(_ name: String, to message: Message) {
    guard message.kind == "owner" || message.kind == "dot" else { return }
    replyTargets[name] = MessageQuote(source: "notch", id: message.id, place: name,
      author: message.kind, text: String(message.text.prefix(240)))
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
