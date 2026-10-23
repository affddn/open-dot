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

/// The unread feed as shown, with the owner's dismissals laid over the daemon's polls. A dismissed
/// item hides at once. It stays hidden until a poll begun after its dismissal succeeded, so a poll
/// already in flight can't bring it back. A failed one comes back with its error, and a poll begun
/// before the failure can't take it away again. Only the newest poll counts.
struct FeedState {
  private var allItems: [FeedItem] = []
  var items: [FeedItem] { Array(allItems.prefix(1000)) }
  var overflowCount: Int { max(0, allItems.count - 1000) }
  var errors: [Int: String] = [:]
  private var hiding: Set<Int> = []
  private var done: Set<Int> = []
  /// Failed dismissals put back, with the event count when they were.
  private var restored: [Int: (item: FeedItem, at: Int)] = [:]
  private var events = 0
  private var polls = 0

  struct Poll {
    fileprivate let number: Int
    fileprivate let at: Int
    fileprivate let settled: Set<Int>
  }

  /// Hides these items and clears their errors while their dismissal is sent.
  mutating func dismiss(_ ids: [Int]) {
    hiding.formUnion(ids)
    allItems.removeAll { ids.contains($0.id) }
    for id in ids {
      errors[id] = nil
      restored[id] = nil
    }
  }

  /// What the daemon answered: the IDs it dismissed. Every other one comes back with its error.
  mutating func finish(_ sent: [FeedItem], dismissed: Set<Int>, error: (Int) -> String) {
    events += 1
    for item in sent {
      if dismissed.contains(item.id) {
        done.insert(item.id)
        continue
      }
      hiding.remove(item.id)
      restored[item.id] = (item, events)
      errors[item.id] = error(item.id)
      if !allItems.contains(where: { $0.id == item.id }) { allItems.append(item) }
    }
    allItems.sort { $0.time < $1.time }
  }

  mutating func startPoll() -> Poll {
    polls += 1
    return Poll(number: polls, at: events, settled: done)
  }

  func isCurrent(_ poll: Poll) -> Bool { poll.number == polls }

  /// Shows a poll's unread items. False when a newer poll has started, so this one is dropped.
  mutating func apply(_ poll: Poll, _ listed: [FeedItem]) -> Bool {
    guard isCurrent(poll) else { return false }
    hiding.subtract(poll.settled)
    done.subtract(poll.settled)
    restored = restored.filter { $0.value.at > poll.at }
    var next = listed.filter { !hiding.contains($0.id) }
    for (id, entry) in restored where !hiding.contains(id) && !next.contains(where: { $0.id == id }) {
      next.append(entry.item)
    }
    allItems = next.sorted { $0.time < $1.time }
    return true
  }
}

@MainActor @Observable final class Store {
  var dots: [Dot] = []
  var status: String?
  var loaded = false
  var selected: String?
  var messages: [String: [Message]] = [:]
  var pending: [String: [Pending]] = [:]
  /// Per dot, where each accepted send stands until it's in the conversation: sending, confirming or sent.
  var sendStatus: [String: [String: String]] = [:]
  var drafts: [String: String] = [:]
  var draftImages: [String: [DraftImage]] = [:]
  var imageErrors: [String: String] = [:]
  var replyTargets: [String: MessageQuote] = [:]
  var sending: Set<String> = []
  var expanded = false
  var feedState = FeedState()
  var feed: [FeedItem] { feedState.items }
  private var sourceFeedRemaining = 0
  var feedRemaining: Int { max(sourceFeedRemaining, feedState.overflowCount) }
  var handedOff: [FeedItem] = []
  /// The feed item being replied to, the dots it goes to in the order picked, and the prompt.
  var replying: FeedItem?
  var replyDots: [String] = []
  var replyDraft = ""
  var feedErrors: [Int: String] {
    get { feedState.errors }
    set { feedState.errors = newValue }
  }
  var feedStatus: String?
  var showingFeed = false
  /// The selected dot's Memory tab is open instead of its chat.
  var showingMemory = false
  var memories: [String: MemoryState] = [:]
  var thumbnails: [AttachmentKey: NSImage] = [:]
  var unavailable: Set<AttachmentKey> = []
  /// Workers being opened or stopped, and what the last attempt for each said.
  var workerBusy: Set<Int> = []
  var workerNotices: [Int: String] = [:]
  /// Threads requests being opened, and what the last attempt for each said, by request number.
  var requestBusy: Set<Int> = []
  var requestNotices: [Int: String] = [:]
  /// Each dot's worker requests and answers, read with its memory. Nil from older daemons.
  var requestAudits: [String: RequestAuditState] = [:]
  var reacting: Set<MessageKey> = []
  var reactionErrors: [MessageKey: String] = [:]
  /// The owner's latest non-classic emoji, newest first, as the daemon last reported them.
  var recentEmojis: [String] = []
  /// Bumped around each reaction, so a poll that overlaps one can't bring back older recent emoji.
  @ObservationIgnored private var recentWrites = 0
  /// Set once reactions overlap. Their responses may then answer out of order, so none is used for
  /// the recent emoji; one fresh read after the last ends replaces them.
  @ObservationIgnored private var recentContended = false
  var hiding: Set<MessageKey> = []
  /// Why the last menu action on a message failed, shown under it.
  var actionErrors: [MessageKey: String] = [:]
  /// Why a menu action failed once its message isn't shown, or for a message still being sent,
  /// shown above the dot's message box.
  var chatActionErrors: [String: String] = [:]
  /// Bumped around each reaction or hide, so a poll that overlaps one is discarded.
  @ObservationIgnored private var writeEpoch: [String: Int] = [:]
  /// Menus, alerts and the share picker keep the notch open while they're up.
  @ObservationIgnored private var holds = 0
  @ObservationIgnored var onRelease: () -> Void = {}
  @ObservationIgnored private var exporting: Set<MessageKey> = []
  @ObservationIgnored private var sharing: ShareDelegate?
  @ObservationIgnored private var messageReads: [String: Int] = [:]
  private var seen: [String: Double] = [:]
  private var newest: [String: Double] = [:]
  private var feedSeen: Double?
  private var feedNewest: Double = 0
  @ObservationIgnored private var loading: Set<AttachmentKey> = []
  @ObservationIgnored private var opening: Set<AttachmentKey> = []
  @ObservationIgnored private let api = API()

  var showsIndicator: Bool { dotsBusy || dotsUnread || feedUnread }

  // The dot list goes stale while OpenCode is down, so it lights nothing then.
  var dotsBusy: Bool { status == nil && dots.contains(where: \.busy) }

  var dotsUnread: Bool { status == nil && dots.contains { unread($0.name) } }

  var feedUnread: Bool { feedNewest > (feedSeen ?? .infinity) }

  func unread(_ name: String) -> Bool { (newest[name] ?? 0) > (seen[name] ?? .infinity) }

  private func visible(_ name: String) -> Bool { expanded && !showingFeed && !showingMemory && selected == name }

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
        if let name = selected, expanded, !showingFeed, showingMemory { await refreshMemory(name) }
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
    if let name = selected, showingMemory { Task { await refreshMemory(name) } }
  }

  func select(_ name: String) {
    showingFeed = false
    selected = name
    if !showingMemory { seen[name] = newest[name] }
    Task { await refreshMessages(name) }
    if showingMemory { Task { await refreshMemory(name) } }
  }

  /// Switches the selected dot between its chat and its Memory tab.
  func showMemory(_ show: Bool) {
    showingMemory = show
    guard let name = selected else { return }
    if show { Task { await refreshMemory(name) } } else { seen[name] = newest[name] }
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
    showingMemory = false
    select(first)
  }

  func dismiss(_ name: String, _ id: UUID) {
    pending[name]?.removeAll { $0.id == id }
  }

  func react(_ key: MessageKey, emoji: String) {
    guard let message = messages[key.dot]?.first(where: { $0.id == key.message }),
      message.kind == "dot", reacting.insert(key).inserted else { return }
    let selected = message.reactions?.first(where: { $0.actor == "owner" })?.emoji
    let next = selected == emoji ? nil : emoji
    writeEpoch[key.dot, default: 0] += 1
    recentWrites += 1
    if reacting.count > 1 { recentContended = true }
    reactionErrors[key] = nil
    Task {
      defer {
        reacting.remove(key)
        writeEpoch[key.dot, default: 0] += 1
        recentWrites += 1
        if reacting.isEmpty && recentContended {
          recentContended = false
          Task { await refreshMessages(key.dot) }
        }
      }
      do {
        let (confirmed, recent) = try await api.react(key, emoji: next)
        guard confirmed.dot == key.dot, confirmed.messageID == key.message,
          confirmed.actor == "owner", confirmed.emoji == next else {
          reactionErrors[key] = "Reaction outcome unknown: unexpected response. Refreshing saved state."
          return
        }
        // Only a reaction that overlapped no other knows the latest order.
        if let recent, !recentContended, recent != recentEmojis { recentEmojis = recent }
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

  var held: Bool { holds > 0 }

  func hold() { holds += 1 }

  func release() {
    holds = max(0, holds - 1)
    if holds == 0 { onRelease() }
  }

  /// The message as shown now, only while it's still the one in the session a menu was opened for.
  func current(_ key: MessageKey, session: String?) -> Message? {
    messages[key.dot]?.first { $0.id == key.message && $0.sessionID == session && $0.hidden != true }
  }

  /// A delayed action's message, or nil, saying so, once it's gone or the dot's session changed.
  /// The action is refused rather than applied to whatever is shown now.
  func stillShown(_ key: MessageKey, session: String?) -> Message? {
    if let message = current(key, session: session) { return message }
    fail(key, "This message changed or is gone, so nothing was done.")
    return nil
  }

  /// Copies the message's plain text, not its rendered Markdown. An image-only message copies its
  /// images. If any fails to load, the clipboard is left as it was.
  func copy(_ key: MessageKey, session: String?) {
    guard let message = stillShown(key, session: session) else { return }
    actionErrors[key] = nil
    chatActionErrors[key.dot] = nil
    if !message.text.isEmpty { return Self.copyText(message.text) }
    let items = message.attachments?.filter(\.isImage) ?? []
    guard !items.isEmpty else { return fail(key, "There's nothing to copy.") }
    export(key, session: session, items, verb: "copied") { images in
      let board = NSPasteboard.general
      board.clearContents()
      board.writeObjects(images.map { image in
        let item = NSPasteboardItem()
        item.setData(image.data, forType: image.type)
        return item
      })
    }
  }

  static func copyText(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
  }

  /// Shares the plain text and every supported image, or nothing if any image fails to load.
  func share(_ key: MessageKey, session: String?, from view: NSView) {
    guard let message = stillShown(key, session: session) else { return }
    actionErrors[key] = nil
    chatActionErrors[key.dot] = nil
    let items = message.attachments?.filter(\.isImage) ?? []
    guard !message.text.isEmpty || !items.isEmpty else { return fail(key, "There's nothing to share.") }
    let text = message.text
    export(key, session: session, items, verb: "shared") { [self, weak view] images in
      let shared = images.compactMap { NSImage(data: $0.data) }
      guard shared.count == images.count else {
        return fail(key, "Couldn't read every image, so nothing was shared.")
      }
      var all: [Any] = text.isEmpty ? [] : [text]
      all.append(contentsOf: shared)
      present(all, dot: key.dot, key: key, from: view)
    }
  }

  private static let shareTimeout = Duration.seconds(60)

  /// Shows the share picker beside the view, closing any earlier one, and keeps the notch open
  /// until it closes. If AppKit never reports back, the picker is closed after a minute, saying so.
  /// The picker holds the only reference to the items, so they go when it does.
  func present(_ items: [Any], dot: String, key: MessageKey?, from view: NSView?) {
    guard let view, view.window != nil else {
      return report("The message scrolled away, so nothing was shared.", dot: dot, key: key)
    }
    guard !items.isEmpty else { return report("There's nothing to share.", dot: dot, key: key) }
    // Held before the earlier picker lets go, so the notch doesn't fold in between.
    hold()
    sharing?.close()
    let picker = NSSharingServicePicker(items: items)
    let delegate = ShareDelegate(picker, timeout: Self.shareTimeout) { [weak self] timedOut in
      guard let self else { return }
      sharing = nil
      release()
      if timedOut {
        report("The share menu didn't answer within a minute, so it was closed. Nothing more will be shared from it.", dot: dot, key: key)
      }
    }
    picker.delegate = delegate
    sharing = delegate
    picker.show(relativeTo: view.bounds, of: view, preferredEdge: .minY)
  }

  private struct Original {
    let type: NSPasteboard.PasteboardType
    let data: Data
  }

  private static let exportLimit = 10

  /// Reads each image again through the daemon, checked like every decode, and hands them all to
  /// `use` only if every one loaded and the message is still shown. The notch stays open meanwhile.
  private func export(_ key: MessageKey, session: String?, _ items: [Message.Attachment], verb: String, _ use: @escaping ([Original]) -> Void) {
    guard items.count <= Self.exportLimit else {
      return fail(key, "This message has more than \(Self.exportLimit) images, so nothing was \(verb).")
    }
    guard exporting.insert(key).inserted else { return }
    hold()
    Task {
      defer {
        exporting.remove(key)
        release()
      }
      var images: [Original] = []
      for item in items {
        // Pinned to the captured session, so an unseen rebinding can't export another session's bytes.
        let data = try? await api.attachment(AttachmentKey(dot: key.dot, message: key.message, index: item.index), session: session)
        guard let data, let checked = Self.checked(data) else {
          return fail(key, "Couldn't load every image, so nothing was \(verb). No automatic retry.")
        }
        images.append(Original(type: NSPasteboard.PasteboardType(checked.type), data: data))
      }
      guard current(key, session: session) != nil else {
        return fail(key, "This message changed or is gone, so nothing was \(verb).")
      }
      use(images)
    }
  }

  /// Hides the message in the notch only. OpenCode history and the dot's memory keep it.
  func hide(_ key: MessageKey, session: String) {
    guard stillShown(key, session: session) != nil, hiding.insert(key).inserted else { return }
    writeEpoch[key.dot, default: 0] += 1
    actionErrors[key] = nil
    chatActionErrors[key.dot] = nil
    Task {
      defer {
        hiding.remove(key)
        writeEpoch[key.dot, default: 0] += 1
      }
      do {
        let marker = try await api.hide(key, session: session)
        guard marker.dot == key.dot, marker.sessionID == session, marker.messageID == key.message else {
          return fail(key, "Delete outcome unknown: unexpected response. The next refresh shows the saved state.")
        }
        if let index = messages[key.dot]?.firstIndex(where: { $0.id == key.message && $0.sessionID == session }) {
          messages[key.dot]![index].hidden = true
        }
        // Queued replies keep their own quote; only the unsent selection goes.
        if replyTargets[key.dot]?.id == key.message { replyTargets[key.dot] = nil }
      } catch {
        if let failure = error as? APIError, case .lost = failure {
          fail(key, "Delete outcome unknown: no response. It may be hidden after the next refresh. No automatic retry.")
        } else {
          fail(key, "Not deleted. \(Self.describe(error)) No automatic retry.")
        }
      }
    }
  }

  private func fail(_ key: MessageKey, _ text: String) { report(text, dot: key.dot, key: key) }

  /// Shows a failure under its message while that message is shown, otherwise above the dot's
  /// message box, so it's never only spoken, and reads it aloud.
  func report(_ text: String, dot: String, key: MessageKey?) {
    if let key, messages[dot]?.contains(where: { $0.id == key.message && $0.hidden != true }) == true {
      actionErrors[key] = text
    } else {
      chatActionErrors[dot] = text
    }
    Self.announce(text)
  }

  /// Reads a failure aloud with VoiceOver, since a menu action has no control left to report on.
  static func announce(_ text: String) {
    NSAccessibility.post(element: NSApp as NSApplication, notification: .announcementRequested, userInfo: [
      .announcement: text,
      .priority: NSAccessibilityPriorityLevel.high.rawValue,
    ])
  }

  func openFeed() {
    showingFeed = true
    feedSeen = feedNewest
    Task { await refreshFeed() }
  }

  func dismissFeed(_ item: FeedItem) {
    feedState.dismiss([item.id])
    Task {
      do {
        try await api.dismissFeed(item.id)
        feedState.finish([item], dismissed: [item.id]) { _ in "" }
      } catch {
        let message = Self.describeDismissal(error)
        feedState.finish([item], dismissed: []) { _ in message }
      }
    }
  }

  /// Dismisses exactly the unread items shown now, in one request. Items that arrive meanwhile
  /// stay. Each one that isn't dismissed comes back with its error, and none is sent again on its own.
  func clearFeed() {
    let shown = feed
    guard !shown.isEmpty else { return }
    let ids = shown.map(\.id)
    feedState.dismiss(ids)
    Task {
      do {
        let result = try await api.dismissFeed(ids)
        let missing = Set(result.missing)
        feedState.finish(shown, dismissed: Set(result.dismissed)) {
          missing.contains($0) ? "There's no such feed item." : "The daemon didn't confirm this one."
        }
        if feedRemaining > 0 { await refreshFeed() }
      } catch {
        let message = Self.describeDismissal(error)
        feedState.finish(shown, dismissed: []) { _ in message }
      }
    }
  }

  func clearFeedError(_ id: Int) {
    feedErrors[id] = nil
  }

  /// Adds the owner's note. A failed or unanswered add keeps the draft and is never sent again on
  /// its own; success clears the draft only if it's unchanged since.
  func addNote(_ name: String) {
    let draft = memories[name]?.noteDraft ?? ""
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    guard text.utf16.count <= memoryTextLimit else {
      memories[name, default: MemoryState()].notice = "A note must be at most \(memoryTextLimit) characters."
      return
    }
    guard memories[name, default: MemoryState()].beginAdd() else { return }
    Task {
      do {
        let note = try await api.addNote(name, text: text)
        memories[name, default: MemoryState()].finishAdd(.success(note))
        if memories[name]?.noteDraft == draft { memories[name]?.noteDraft = "" }
      } catch {
        let message = Self.describeMemory(error, "Not added", unknown: "It may have been added; it shows on the next refresh.")
        memories[name, default: MemoryState()].finishAdd(.failure(MemoryInvalid(message)))
      }
    }
  }

  /// Opens the worker's session in a new terminal window. If none opens, the daemon copies the
  /// command and the notice says so. Never retried on its own.
  func openWorker(_ worker: Dot.Worker) {
    guard workerBusy.insert(worker.id).inserted else { return }
    workerNotices[worker.id] = nil
    Task {
      do {
        workerNotices[worker.id] = try await api.openWorker(worker.id).notice
      } catch {
        workerNotices[worker.id] = Self.describeMemory(error, "Not opened", unknown: "A window may have opened anyway.")
      }
      workerBusy.remove(worker.id)
    }
  }

  /// Opens a Threads worker's session from its request. Never retried on its own.
  func openRequest(_ request: Dot.SessionRequest) {
    guard requestBusy.insert(request.request).inserted else { return }
    requestNotices[request.request] = nil
    Task {
      do {
        requestNotices[request.request] = try await api.openRequest(request.request).notice
      } catch {
        requestNotices[request.request] = Self.describeMemory(error, "Not opened", unknown: "A window may have opened anyway.")
      }
      requestBusy.remove(request.request)
    }
  }

  /// Stops a worker the owner confirmed, then reads the dots again. A stop OpenCode didn't confirm
  /// says so; the owner may stop it again, but it's never retried on its own.
  func stopWorker(_ worker: Dot.Worker) {
    guard workerBusy.insert(worker.id).inserted else { return }
    workerNotices[worker.id] = nil
    Task {
      do {
        _ = try await api.stopWorker(worker.id)
      } catch {
        workerNotices[worker.id] = Self.describeMemory(error, "Not stopped", unknown: "It may have stopped; the list shows what the daemon has.")
      }
      workerBusy.remove(worker.id)
      await refreshDots()
    }
  }

  /// Approves or ends a supervision the owner confirmed, then reads the memory again. A failed or
  /// unanswered change says so and is never sent again on its own.
  func changeSupervision(_ name: String, _ binding: Supervision, approve: Bool) {
    guard memories[name, default: MemoryState()].supervising.insert(binding.id).inserted else { return }
    memories[name]?.notice = nil
    Task {
      do {
        _ = try await api.changeSupervision(name, binding.id, approve: approve)
      } catch {
        let message = Self.describeMemory(error, approve ? "Not approved" : "Not ended", unknown: "It may have changed; the next refresh shows what the daemon has.")
        memories[name, default: MemoryState()].notice = message
      }
      memories[name]?.supervising.remove(binding.id)
      await refreshMemory(name)
    }
  }

  /// Sends the edit at the version the owner started from. Nothing changed closes the editor.
  func saveMemory(_ name: String, _ key: MemoryKey) {
    guard let draft = memories[name]?.drafts[key] else { return }
    let changed: [String: Any]?
    do {
      changed = try draft.changes()
    } catch {
      memories[name]?.errors[key] = (error as? MemoryInvalid)?.message ?? "\(error)"
      return
    }
    guard var fields = changed else {
      memories[name]?.drafts[key] = nil
      return
    }
    fields["version"] = draft.version
    guard let body = try? JSONSerialization.data(withJSONObject: fields) else { return }
    change(name, key, version: draft.version, body: body)
  }

  /// Deletes a note or cancels a reminder at the version shown, once the owner confirmed it.
  func removeMemory(_ name: String, _ item: MemoryItem) {
    let version: Int
    switch item {
    case .note(let note): version = note.version
    case .reminder(let reminder): version = reminder.version
    case .responsibility: return
    }
    change(name, item.key, version: version, body: nil)
  }

  private func change(_ name: String, _ key: MemoryKey, version: Int, body: Data?) {
    guard memories[name, default: MemoryState()].begin(key) else { return }
    Task {
      do {
        let outcome = try await api.changeMemory(name, key, version: version, body: body)
        memories[name, default: MemoryState()].finish(key, .outcome(outcome))
      } catch {
        let message = Self.describeMemory(error, "Not saved", unknown: "It may have been saved; the next refresh shows what the daemon has.")
        memories[name, default: MemoryState()].finish(key, .failed(message))
      }
    }
  }

  /// Reads the newest audit page again, keeping older pages already loaded.
  private func refreshAudit(_ name: String) async {
    var state = requestAudits[name] ?? RequestAuditState()
    let read = state.startRead()
    requestAudits[name] = state
    guard let page = try? await api.requests(name) else { return }
    requestAudits[name]?.apply(read, page, older: false)
  }

  /// Reads the next older audit page, once at a time. A failure leaves what's shown.
  func loadOlderAudit(_ name: String) {
    guard var state = requestAudits[name], let before = state.older, !state.loadingOlder else { return }
    state.loadingOlder = true
    let read = state.startRead()
    requestAudits[name] = state
    Task {
      if let page = try? await api.requests(name, before: before) {
        requestAudits[name]?.apply(read, page, older: true)
      }
      requestAudits[name]?.loadingOlder = false
    }
  }

  private func refreshMemory(_ name: String) async {
    let read = memories[name, default: MemoryState()].startRead()
    do {
      let memory = try await api.memory(name)
      _ = memories[name, default: MemoryState()].apply(read, memory)
      await refreshAudit(name)
    } catch {
      guard memories[name]?.isCurrent(read) == true else { return }
      memories[name]?.readError = Self.describe(error)
    }
  }

  private static func describeMemory(_ error: Error, _ refused: String, unknown: String) -> String {
    if case .lost = error as? APIError { return "Outcome unknown: no response. \(unknown) No automatic retry." }
    return "\(refused). \(describe(error)) No automatic retry."
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

  /// Accepts only PNG, JPEG, GIF and WebP, whatever the bytes claim to be, and only up to 40
  /// million pixels, read from the header without decoding, so a small file can't expand into a
  /// huge bitmap. The type is the image's UTI, which is also its pasteboard type.
  private static func checked(_ data: Data) -> (source: CGImageSource, type: String, side: Int)? {
    let allowed: Set<String> = ["public.png", "public.jpeg", "com.compuserve.gif", "org.webmproject.webp"]
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
      let type = CGImageSourceGetType(source) as String?, allowed.contains(type),
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
      let width = properties[kCGImagePropertyPixelWidth] as? Int,
      let height = properties[kCGImagePropertyPixelHeight] as? Int,
      width > 0, height > 0, width <= 40_000_000 / height else { return nil }
    return (source, type, max(width, height))
  }

  private static func decode(_ data: Data, maxPixels: Int?) -> NSImage? {
    guard let checked = Self.checked(data) else { return nil }
    // The thumbnail API at full size too, so both apply the photo's orientation.
    let image = CGImageSourceCreateThumbnailAtIndex(checked.source, 0, [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: maxPixels ?? checked.side,
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
    let poll = feedState.startPoll()
    let result: (items: [FeedItem], handedOff: [FeedItem], remaining: Int)
    do {
      result = try await api.feed()
    } catch {
      guard feedState.isCurrent(poll) else { return }
      feedStatus = Self.describe(error)
      return
    }
    guard feedState.apply(poll, result.items) else { return }
    handedOff = result.handedOff
    sourceFeedRemaining = result.remaining
    feedStatus = nil
    feedNewest = feed.map(\.time).max() ?? 0
    if feedSeen == nil || (expanded && showingFeed) { feedSeen = feedNewest }
  }

  private func refreshMessages(_ name: String) async {
    let epoch = writeEpoch[name, default: 0]
    let recentEpoch = recentWrites
    messageReads[name, default: 0] += 1
    let read = messageReads[name]
    guard let result = try? await api.messages(name) else { return }
    let (list, statuses, recent) = result
    // Discard polls begun before/during a write, and older overlapping reads.
    guard epoch == writeEpoch[name, default: 0], read == messageReads[name],
      !reacting.contains(where: { $0.dot == name }), !hiding.contains(where: { $0.dot == name }) else { return }
    messages[name] = list
    sendStatus[name] = statuses
    // Recent emoji are the owner's across dots, so a reaction to any dot's message makes this read stale.
    if let recent, recentEpoch == recentWrites, reacting.isEmpty, recent != recentEmojis { recentEmojis = recent }
    // Hidden messages still count here, so a pending send matches its delivered ID.
    let ids = Set(list.map(\.id))
    let shown = Set(list.filter { $0.hidden != true }.map(\.id))
    // Forget images of messages that have scrolled out or were hidden, but write only when something goes.
    let gone = { (key: AttachmentKey) in key.dot == name && !shown.contains(key.message) }
    if thumbnails.keys.contains(where: gone) { thumbnails = thumbnails.filter { !gone($0.key) } }
    if unavailable.contains(where: gone) { unavailable = unavailable.filter { !gone($0) } }
    let oldest = list.first?.time ?? 0
    // An accepted message older than everything shown was delivered and has scrolled out, unless
    // the daemon still lists it as not delivered.
    pending[name]?.removeAll { item in
      item.messageID.map { ids.contains($0) || (oldest > item.sentAt && statuses[$0] == nil) } ?? false
    }
    let latest = list.filter { $0.kind != "owner" && $0.hidden != true }.map(\.time).max() ?? 0
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

  private static func describeDismissal(_ error: Error) -> String {
    if case .lost = error as? APIError { return "No response from the open-dot daemon. It may have been dismissed anyway." }
    return describe(error)
  }
}

/// Ends the notch's hold once the share picker closes, with or without a choice, or once its time
/// limit passes without an answer. AppKit doesn't mark the picker's delegate main-actor, though it
/// calls it on the main thread.
@MainActor final class ShareDelegate: NSObject, @preconcurrency NSSharingServicePickerDelegate {
  private var picker: NSSharingServicePicker?
  private var done: ((_ timedOut: Bool) -> Void)?
  private var timeout: Task<Void, Never>?

  init(_ picker: NSSharingServicePicker, timeout limit: Duration, done: @escaping (_ timedOut: Bool) -> Void) {
    self.picker = picker
    self.done = done
    super.init()
    // Weak, so a picker AppKit never answers for can't keep this delegate alive past its limit.
    timeout = Task { [weak self] in
      try? await Task.sleep(for: limit)
      guard !Task.isCancelled else { return }
      self?.close(timedOut: true)
    }
  }

  func sharingServicePicker(_ sharingServicePicker: NSSharingServicePicker, didChoose service: NSSharingService?) {
    finish(timedOut: false)
  }

  /// Closes the picker if it's still up. Finishing first means the `didChoose` that `close()`
  /// sends finds nothing left to report.
  func close(timedOut: Bool = false) {
    let picker = self.picker
    finish(timedOut: timedOut)
    picker?.close()
  }

  private func finish(timedOut: Bool) {
    timeout?.cancel()
    timeout = nil
    let done = self.done
    self.done = nil
    picker = nil
    done?(timedOut)
  }
}
