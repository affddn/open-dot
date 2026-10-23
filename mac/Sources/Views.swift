import AppKit
import SwiftUI

let expandedSize = CGSize(width: 520, height: 440)
let earWidth: CGFloat = 26
let messageBlue = Color(red: 10 / 255, green: 132 / 255, blue: 1)
let messageGray = Color(red: 38 / 255, green: 38 / 255, blue: 40 / 255)

extension Animation {
  static let open = Animation.spring(response: 0.42, dampingFraction: 0.8)
  static let close = Animation.spring(response: 0.34, dampingFraction: 1)
}

/// The black shape grows out of the notch and shrinks back into it. The window around it stays transparent.
struct RootView: View {
  @Bindable var store: Store
  let notch: CGSize
  let collapsedRadius: CGFloat
  let onIndicatorChange: () -> Void

  var body: some View {
    let radius = store.expanded ? 22 : collapsedRadius
    let size = store.expanded
      ? expandedSize : CGSize(width: notch.width + (store.showsIndicator ? earWidth * 2 : 0), height: notch.height)
    ZStack(alignment: .top) {
      if store.expanded {
        ExpandedView(store: store, topInset: notch.height)
          .frame(width: expandedSize.width, height: expandedSize.height)
          .transition(
            .asymmetric(
              insertion: .opacity.combined(with: .scale(scale: 0.94, anchor: .top))
                .animation(.easeOut(duration: 0.24).delay(0.06)),
              removal: .opacity.animation(.easeIn(duration: 0.1))))
      } else if store.showsIndicator {
        HStack {
          if store.dotsBusy { BusyDot() }
          Spacer()
          if store.feedUnread || store.dotsUnread { UnreadDot() }
        }
        .padding(.horizontal, 10)
        .frame(height: notch.height)
        .transition(.opacity)
      }
    }
    .frame(width: size.width, height: size.height, alignment: .top)
    .background(.black)
    .clipShape(UnevenRoundedRectangle(bottomLeadingRadius: radius, bottomTrailingRadius: radius))
    .animation(.open, value: store.showsIndicator)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .environment(\.colorScheme, .dark)
    .onChange(of: store.showsIndicator) { onIndicatorChange() }
  }
}

struct BusyDot: View {
  var body: some View {
    Image(systemName: "circle.fill").font(.system(size: 6)).foregroundStyle(.orange).symbolEffect(.pulse)
  }
}

/// A dot's avatar, already downscaled, in a circle. Decorative, so VoiceOver reads only the text.
struct AvatarView: View {
  let image: NSImage
  let size: CGFloat

  var body: some View {
    Image(nsImage: image).resizable().interpolation(.high).scaledToFill()
      .frame(width: size, height: size)
      .clipShape(Circle())
      .accessibilityHidden(true)
  }
}

struct UnreadDot: View {
  var body: some View {
    Circle().fill(.blue).frame(width: 6, height: 6)
  }
}

struct ExpandedView: View {
  @Bindable var store: Store
  let topInset: CGFloat

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      if !store.loaded {
        centered("Connecting…")
      } else {
        HStack(spacing: 8) {
          tabs
          if !store.showingFeed, store.status == nil, store.selected != nil { modes }
        }
        if store.showingFeed {
          FeedList(store: store)
        } else if let status = store.status {
          centered(status)
        } else if let name = store.selected, let dot = store.dots.first(where: { $0.name == name }) {
          if store.showingMemory {
            MemoryView(store: store, name: name)
              .id("memory-\(name)")
          } else {
            Conversation(store: store, name: name)
              .id(name)
            if !dot.workers.isEmpty || !(dot.sessions ?? []).isEmpty { workers(name, dot) }
            composer(name)
          }
        } else {
          centered("No dots yet. Create one with open-dot create.")
        }
      }
    }
    .padding(.top, topInset + 6)
    .padding([.horizontal, .bottom], 14)
    .foregroundStyle(.white)
    .contextMenu { Button("Quit open-dot notch") { NSApp.terminate(nil) } }
  }

  private func centered(_ text: String) -> some View {
    Text(text).foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var tabs: some View {
    ScrollView(.horizontal) {
      HStack(spacing: 4) {
        Button { store.openFeed() } label: {
          HStack(spacing: 5) {
            Text("Feed").font(.callout.weight(.medium))
            if !store.feed.isEmpty {
              Text("\(store.feed.count)")
                .font(.caption2.weight(.semibold).monospacedDigit())
                .padding(.horizontal, 5)
                .background(Capsule().fill(.white.opacity(0.18)))
            }
            if store.feedUnread { UnreadDot() }
          }
          .padding(.horizontal, 10)
          .padding(.vertical, 4)
          .background(Capsule().fill(.white.opacity(store.showingFeed ? 0.18 : 0)))
          .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("feed-tab")
        ForEach(store.dots, id: \.name) { dot in
          Button { store.select(dot.name) } label: {
            HStack(spacing: 5) {
              if dot.busy { BusyDot() }
              if let image = store.avatars.images[dot.name] { AvatarView(image: image, size: 16) }
              Text(dot.name).font(.callout.weight(.medium))
              if dot.needsYouCount > 0 {
                Text("\(dot.needsYouCount)")
                  .font(.caption2.weight(.semibold).monospacedDigit())
                  .padding(.horizontal, 5)
                  .background(Capsule().fill(.orange.opacity(0.7)))
                  .help("Workers waiting on you")
                  .accessibilityLabel("\(dot.needsYouCount) waiting on you")
                  .accessibilityIdentifier("dot-needs-you-\(dot.name)")
              }
              if store.unread(dot.name) { UnreadDot() }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(Capsule().fill(.white.opacity(!store.showingFeed && dot.name == store.selected ? 0.18 : 0)))
            .contentShape(Capsule())
          }
          .buttonStyle(.plain)
          .help(dot.purpose ?? "")
          .accessibilityIdentifier("dot-tab-\(dot.name)")
        }
      }
    }
    .scrollIndicators(.hidden)
  }

  /// The selected dot's chat, or its notes, responsibilities and reminders.
  private var modes: some View {
    Picker("View", selection: Binding { store.showingMemory } set: { store.showMemory($0) }) {
      Text("Chat").tag(false)
      Text("Memory").tag(true)
    }
    .pickerStyle(.segmented)
    .labelsHidden()
    .fixedSize()
    .accessibilityIdentifier("dot-mode")
  }

  private func workers(_ name: String, _ dot: Dot) -> some View {
    let workers = dot.workers
    let threads = dot.sessions ?? []
    return VStack(alignment: .leading, spacing: 3) {
      ScrollView(.horizontal) {
        HStack(spacing: 6) {
          ForEach(workers, id: \.id) { worker in workerRow(name, worker) }
          ForEach(threads, id: \.sessionID) { request in threadsRow(request) }
        }
      }
      .scrollIndicators(.hidden)
      ForEach(workers.filter { store.workerNotices[$0.id] != nil }, id: \.id) { worker in
        Text(verbatim: "#\(worker.id): \(store.workerNotices[worker.id] ?? "")")
          .font(.caption2)
          .foregroundStyle(.orange)
          .textSelection(.enabled)
          .accessibilityIdentifier("worker-notice-\(worker.id)")
      }
      ForEach(threads.filter { store.requestNotices[$0.request] != nil }, id: \.sessionID) { request in
        Text(verbatim: "\(request.title): \(store.requestNotices[request.request] ?? "")")
          .font(.caption2)
          .foregroundStyle(.orange)
          .textSelection(.enabled)
          .accessibilityIdentifier("request-notice-\(request.request)")
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("workers")
  }

  /// A Threads worker's or finished worker's requests. Its session opens here; a Threads worker
  /// stops in Threads.
  private func threadsRow(_ request: Dot.SessionRequest) -> some View {
    HStack(spacing: 6) {
      Text(verbatim: request.line)
        .foregroundStyle(request.needsYou ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
        .lineLimit(1)
        .frame(maxWidth: 220, alignment: .leading)
      if store.requestBusy.contains(request.request) {
        Text("…").foregroundStyle(.secondary)
      } else {
        Button("Open") { store.openRequest(request) }
          .help(request.source == "threads" ? "Open its session in a new terminal window. Stop it in Threads." : "Open its session in a new terminal window.")
          .accessibilityIdentifier("session-open-\(request.request)")
      }
    }
    .buttonStyle(.plain)
    .font(.caption2)
    .padding(.horizontal, 8)
    .padding(.vertical, 3)
    .background(Capsule().fill(request.needsYou ? .orange.opacity(0.18) : .white.opacity(0.08)))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("session-requests-\(request.sessionID)")
  }

  private func workerRow(_ name: String, _ worker: Dot.Worker) -> some View {
    HStack(spacing: 6) {
      Text(verbatim: worker.line)
        .foregroundStyle(worker.needsYou ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
        .lineLimit(1)
        .frame(maxWidth: 220, alignment: .leading)
      if store.workerBusy.contains(worker.id) {
        Text("…").foregroundStyle(.secondary)
      } else {
        if worker.canOpen {
          Button("Open") { store.openWorker(worker) }
            .help("Open its session in a new terminal window")
            .accessibilityIdentifier("worker-open-\(worker.id)")
        }
        if worker.canStop {
          Button("Stop…") { confirmStop(worker, dot: name, store: store) }
            .accessibilityIdentifier("worker-stop-\(worker.id)")
        }
      }
    }
    .buttonStyle(.plain)
    .font(.caption2)
    .padding(.horizontal, 8)
    .padding(.vertical, 3)
    .background(Capsule().fill(worker.needsYou ? .orange.opacity(0.18) : .white.opacity(0.08)))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("worker-\(worker.id)")
  }

  private func composer(_ name: String) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      if let quote = store.replyTargets[name] {
        HStack {
          MessageQuoteView(quote: quote, dot: name)
          Button("Cancel") { store.replyTargets[name] = nil }
            .buttonStyle(.plain)
            .accessibilityIdentifier("chat-reply-cancel")
        }
      }
      if let images = store.draftImages[name], !images.isEmpty {
        ScrollView(.horizontal) {
          HStack(spacing: 6) {
            ForEach(images) { image in
              Image(nsImage: image.thumbnail).resizable().scaledToFill()
                .frame(width: 64, height: 48).clipped()
                .overlay(alignment: .topTrailing) {
                  Button { store.removeImage(image.id, from: name) } label: {
                    Image(systemName: "xmark.circle.fill").background(.black, in: Circle())
                  }
                  .buttonStyle(.plain)
                  .accessibilityLabel("Remove \(image.file.name)")
                }
                .help(image.file.name)
            }
          }
        }.frame(height: 48).scrollIndicators(.never)
      }
      if let error = store.imageErrors[name] {
        Text(error).font(.caption2).foregroundStyle(.red)
      }
      if let error = store.chatActionErrors[name] {
        Text("\(error) · click to clear").font(.caption2).foregroundStyle(.red)
          .onTapGesture { store.chatActionErrors[name] = nil }
          .accessibilityIdentifier("chat-action-error")
      }
      Composer(placeholder: "Message \(name)", text: Binding { store.drafts[name] ?? "" } set: { store.drafts[name] = $0 }, canSend: !store.sending.contains(name), hasImages: !(store.draftImages[name] ?? []).isEmpty,
        pasteImages: { store.pasteImages($0, to: name) }, pickImages: { store.pickImages(name) }) {
        store.send(name)
      }
      .id(name)
    }
  }
}

struct Composer: View {
  let placeholder: String
  @Binding var text: String
  var canSend = true
  var hasImages = false
  var pasteImages: ((NSPasteboard) -> Bool)? = nil
  var pickImages: (() -> Void)? = nil
  let send: () -> Void
  @State private var height: CGFloat = 22

  var body: some View {
    let blocked = (text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !hasImages) || !canSend
    HStack(alignment: .bottom) {
      if let pickImages {
        Button(action: pickImages) { Image(systemName: "paperclip") }
          .buttonStyle(.plain)
          .accessibilityLabel("Attach images")
      }
      DraftEditor(text: $text, height: $height, placeholder: placeholder, hasImages: hasImages, pasteImages: pasteImages, send: { if canSend { send() } })
        .frame(height: height)
        .overlay(alignment: .topLeading) {
          // The editor's own label is for VoiceOver only, so the placeholder is drawn over it.
          if text.isEmpty {
            Text(placeholder)
              .font(.system(size: 13))
              .foregroundStyle(.tertiary)
              .padding(.leading, 5)
              .padding(.top, 3)
              .allowsHitTesting(false)
              .accessibilityHidden(true)
          }
        }
      Button(action: send) {
        Image(systemName: "arrow.up.circle.fill").font(.title2)
      }
      .buttonStyle(.plain)
      .disabled(blocked)
      .opacity(blocked ? 0.4 : 1)
      .accessibilityLabel("Send")
      .accessibilityIdentifier("send")
    }
    .padding(.leading, 12)
    .padding(.trailing, 6)
    .padding(.vertical, 6)
    .background(RoundedRectangle(cornerRadius: 14).fill(.white.opacity(0.08)))
  }
}

struct DraftEditor: NSViewRepresentable {
  @Binding var text: String
  @Binding var height: CGFloat
  let placeholder: String
  let hasImages: Bool
  let pasteImages: ((NSPasteboard) -> Bool)?
  let send: () -> Void

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  func makeNSView(context: Context) -> NSScrollView {
    let scroll = NSScrollView()
    scroll.drawsBackground = false
    scroll.hasVerticalScroller = true
    let editor = DraftTextView()
    editor.isRichText = false
    editor.allowsUndo = true
    editor.drawsBackground = false
    editor.textColor = .white
    editor.font = .systemFont(ofSize: 13)
    editor.textContainerInset = NSSize(width: 0, height: 3)
    editor.isVerticallyResizable = true
    editor.autoresizingMask = [.width]
    editor.textContainer?.widthTracksTextView = true
    editor.delegate = context.coordinator
    if pasteImages != nil { editor.registerForDraggedTypes([.fileURL, .png, .tiff]) }
    editor.setAccessibilityIdentifier("composer")
    scroll.documentView = editor
    return scroll
  }

  func updateNSView(_ scroll: NSScrollView, context: Context) {
    context.coordinator.parent = self
    guard let editor = scroll.documentView as? DraftTextView else { return }
    editor.send = send
    editor.hasImages = hasImages
    editor.pasteImages = pasteImages
    editor.setAccessibilityLabel(placeholder)
    if editor.string != text {
      // The text changed outside the editor, as after a send or a quick prompt, so earlier undo
      // steps no longer fit it.
      editor.history.removeAllActions()
      editor.string = text
    }
    DispatchQueue.main.async {
      let size = measuredSize(scroll, width: max(scroll.contentSize.width, 1))
      if height != size.height { height = size.height }
    }
  }

  private func measuredSize(_ scroll: NSScrollView, width: CGFloat) -> CGSize {
    guard let editor = scroll.documentView as? NSTextView,
      let container = editor.textContainer, let layout = editor.layoutManager else { return CGSize(width: width, height: 22) }
    container.containerSize = NSSize(width: width, height: .greatestFiniteMagnitude)
    layout.ensureLayout(for: container)
    let line = layout.defaultLineHeight(for: editor.font ?? .systemFont(ofSize: 13))
    let height = max(line, layout.usedRect(for: container).height + (editor.string.hasSuffix("\n") ? line : 0)) + 6
    editor.setFrameSize(NSSize(width: width, height: height))
    return CGSize(width: width, height: min(height, line * 6 + 6))
  }

  class Coordinator: NSObject, NSTextViewDelegate {
    var parent: DraftEditor
    init(_ parent: DraftEditor) { self.parent = parent }
    func textDidChange(_ notification: Notification) {
      guard let editor = notification.object as? NSTextView else { return }
      parent.text = editor.string
    }
  }
}

class DraftTextView: NSTextView {
  var send: () -> Void = {}
  var hasImages = false
  var pasteImages: ((NSPasteboard) -> Bool)?

  override func paste(_ sender: Any?) {
    if pasteImages?(NSPasteboard.general) == true { return }
    super.paste(sender)
  }

  override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
    if pasteImages != nil, sender.draggingPasteboard.availableType(from: [.fileURL, .png, .tiff]) != nil { return .copy }
    return super.draggingEntered(sender)
  }

  override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
    draggingEntered(sender)
  }

  override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
    if pasteImages?(sender.draggingPasteboard) == true { return true }
    return super.performDragOperation(sender)
  }

  override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
    if pasteImages != nil, sender.draggingPasteboard.availableType(from: [.fileURL, .png, .tiff]) != nil { return true }
    return super.prepareForDragOperation(sender)
  }
  /// Each editor keeps its own undo history, which ends with it. The panel's shared one would let
  /// Command-Z in one dot's draft undo typing in another's.
  let history = UndoManager()

  override var undoManager: UndoManager? { history }

  @objc func undo(_ sender: Any?) { history.undo() }
  @objc func redo(_ sender: Any?) { history.redo() }

  override func validateMenuItem(_ item: NSMenuItem) -> Bool {
    if item.action == #selector(paste(_:)), isEditable, pasteImages != nil,
      NSPasteboard.general.availableType(from: Store.imagePasteboardTypes + [.fileURL]) != nil {
      return true
    }
    return switch item.action {
    case #selector(undo(_:)): history.canUndo
    case #selector(redo(_:)): history.canRedo
    default: super.validateMenuItem(item)
    }
  }

  override func keyDown(with event: NSEvent) {
    if (event.keyCode == 36 || event.keyCode == 76) && !hasMarkedText() {
      if !event.modifierFlags.intersection([.shift, .option]).isEmpty {
        insertNewline(nil)
      } else if hasImages || !string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        send()
      }
      return
    }
    super.keyDown(with: event)
  }
}

struct Conversation: View {
  let store: Store
  let name: String

  var body: some View {
    // Messages deleted in the notch stay in the store, so pending sends still match their IDs.
    let messages = (store.messages[name] ?? []).filter { $0.hidden != true }
    let pending = store.pending[name] ?? []
    ScrollViewReader { proxy in
      ScrollView {
        // Lazy, so a thumbnail loads only when its message scrolls into view.
        LazyVStack(alignment: .leading, spacing: 8) {
          ForEach(messages) { MessageRow(store: store, dot: name, message: $0) }
          // In the conversation means OpenCode delivered it to the dot. Nothing reports whether the
          // model has read it, so there's no "Read".
          if pending.isEmpty, messages.last?.kind == "owner" {
            HStack {
              Spacer()
              Text("Delivered").font(.caption2).foregroundStyle(.tertiary)
            }
            .accessibilityIdentifier("delivered-\(name)")
          }
          ForEach(pending) { item in
            PendingRow(store: store, item: item, dot: name).onTapGesture {
              if item.error != nil { store.dismiss(name, item.id) }
            }
          }
          Color.clear.frame(height: 1).id("end")
        }
      }
      .defaultScrollAnchor(.bottom)
      .scrollIndicators(.never)
      .onChange(of: "\(name) \(messages.last?.id ?? "") \(pending.count)") { proxy.scrollTo("end", anchor: .bottom) }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("message-list")
  }
}

/// Reads like a live stream: it follows new items while you're at the bottom and leaves you in place when you've scrolled up.
struct FeedList: View {
  let store: Store
  @State private var atBottom = true
  @State private var unseen = 0
  @State private var showHanded = false

  var body: some View {
    let items = store.feed
    if let item = store.replying {
      ReplyBox(store: store, item: item)
    } else if let status = store.feedStatus {
      Text(status).foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
    } else if items.isEmpty && store.handedOff.isEmpty {
      Text(store.feedRemaining > 0 ? "More unread items will appear on refresh." : "Nothing needs you right now.")
        .foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
    } else {
      VStack(spacing: 6) {
        if !items.isEmpty { clearAll }
        list(items)
      }
    }
  }

  /// Dismisses the unread items shown, like their own dismiss buttons. Handed-off items stay.
  private var clearAll: some View {
    HStack {
      if store.feedRemaining > 0 {
        Text("\(store.feed.count) shown · at least \(store.feedRemaining) more")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      Spacer()
      Button("Clear all") { store.clearFeed() }
        .buttonStyle(.plain)
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
        .help("Dismiss every unread item shown")
        .accessibilityLabel("Clear all unread")
        .accessibilityIdentifier("feed-clear-all")
    }
  }

  private func list(_ items: [FeedItem]) -> some View {
    GeometryReader { viewport in
      ScrollViewReader { proxy in
        ScrollView {
          VStack(spacing: 6) {
            handed
            ForEach(items) { item in row(item, dismiss: { store.dismissFeed(item) }) }
            Color.clear.frame(height: 1).id("end").background {
              GeometryReader { end in
                Color.clear.onChange(of: end.frame(in: .named("feed")).minY <= viewport.size.height + 8, initial: true) {
                  atBottom = $1
                  if $1 { unseen = 0 }
                }
              }
            }
          }
        }
        .coordinateSpace(name: "feed")
        .scrollIndicators(.never)
        .onAppear { proxy.scrollTo("end", anchor: .bottom) }
        .onChange(of: items.map(\.id)) { old, new in
          if atBottom {
            proxy.scrollTo("end", anchor: .bottom)
          } else {
            unseen += Set(new).subtracting(old).count
          }
        }
        .overlay(alignment: .bottom) {
          if unseen > 0 {
            Button { withAnimation { proxy.scrollTo("end", anchor: .bottom) } } label: {
              Text("\(unseen) new")
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(Capsule().fill(messageBlue))
            }
            .buttonStyle(.plain)
            .padding(.bottom, 6)
            .accessibilityIdentifier("feed-new")
          }
        }
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("feed-list")
  }

  private func row(_ item: FeedItem, dismiss: (() -> Void)? = nil) -> some View {
    FeedRow(item: item, error: store.feedErrors[item.id], dismiss: dismiss, reply: { store.startReply(item) }) {
      store.clearFeedError(item.id)
    }
  }

  /// Items already sent to dots, collapsed. Each can still go to more dots.
  @ViewBuilder private var handed: some View {
    let items = store.handedOff
    if !items.isEmpty {
      DisclosureGroup(isExpanded: $showHanded) {
        VStack(spacing: 6) { ForEach(items) { row($0) } }
      } label: {
        HStack(spacing: 4) {
          Text("Handed off (\(items.count))")
          if items.contains(where: { store.feedErrors[$0.id] != nil }) {
            Text("· some sends failed").foregroundStyle(.red)
          }
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
      }
      .accessibilityIdentifier("feed-handed-off")
    }
  }
}

/// The feed item being replied to, the dots to send it to, and the prompt.
struct ReplyBox: View {
  let store: Store
  let item: FeedItem

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text("Reply").font(.callout.weight(.semibold))
        Spacer()
        Button("Cancel") { store.cancelReply() }
          .buttonStyle(.plain)
          .foregroundStyle(.secondary)
          .accessibilityIdentifier("reply-cancel")
      }
      QuoteCard(item: item)
      ScrollView(.horizontal) {
        HStack(spacing: 4) {
          ForEach(store.dots, id: \.name) { dot in
            let picked = store.replyDots.contains(dot.name)
            Button { store.toggleReplyDot(dot.name) } label: {
              HStack(spacing: 3) {
                if item.handedTo?.contains(dot.name) == true { Image(systemName: "checkmark").font(.caption2) }
                Text(dot.name).font(.callout.weight(.medium))
              }
              .padding(.horizontal, 10)
              .padding(.vertical, 4)
              .background(Capsule().fill(.white.opacity(picked ? 0.25 : 0.06)))
              .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .help(item.handedTo?.contains(dot.name) == true ? "Already has it" : "")
            .accessibilityAddTraits(picked ? .isSelected : [])
            .accessibilityIdentifier("reply-dot-\(dot.name)")
          }
        }
      }
      .scrollIndicators(.hidden)
      HStack(spacing: 6) {
        quick("Start on it", Store.startPrompt)
        quick("Use as context", Store.contextPrompt)
      }
      Spacer(minLength: 0)
      Composer(
        placeholder: store.replyDots.isEmpty ? "Pick a dot first" : "Prompt for \(store.replyDots.joined(separator: ", "))",
        text: Binding { store.replyDraft } set: { store.replyDraft = $0 },
        canSend: !store.replyDots.isEmpty
      ) {
        store.sendReply()
      }
      .id("reply-\(item.id)")
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("reply-box")
  }

  /// Fills the prompt box with text to edit. It sends nothing.
  private func quick(_ title: String, _ prompt: String) -> some View {
    Button(title) { store.replyDraft = prompt }
      .buttonStyle(.plain)
      .font(.caption.weight(.medium))
      .padding(.horizontal, 8)
      .padding(.vertical, 3)
      .background(Capsule().fill(.white.opacity(0.1)))
  }
}

/// A feed item quoted in a reply. Only its web link opens.
struct QuoteCard: View {
  let item: FeedItem

  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      SourceMark(source: item.source)
      VStack(alignment: .leading, spacing: 2) {
        Text(verbatim: "\(item.reason) · \(item.context)").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
        Text(verbatim: item.title).font(.caption).lineLimit(2)
      }
    }
    .padding(8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 8).strokeBorder(.white.opacity(0.2)))
    .contentShape(Rectangle())
    .onTapGesture { openWebLink(item.url) }
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("quote-\(item.id)")
  }
}

/// Feed links come from outside, so only web links open.
@MainActor func openWebLink(_ link: String?) {
  guard let link, let url = URL(string: link), ["http", "https"].contains(url.scheme?.lowercased()) else { return }
  NSWorkspace.shared.open(url)
}

struct FeedRow: View {
  let item: FeedItem
  let error: String?
  let dismiss: (() -> Void)?
  let reply: () -> Void
  let clearError: () -> Void
  @State private var hovering = false

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(alignment: .top, spacing: 8) {
        SourceMark(source: item.source)
        VStack(alignment: .leading, spacing: 2) {
          HStack(spacing: 4) {
            Text(verbatim: item.reason).font(.caption.weight(.semibold))
            Text(verbatim: "· \(item.context)").font(.caption).foregroundStyle(.secondary).lineLimit(1)
            Spacer(minLength: 4)
            Text(verbatim: ago(item.time)).font(.caption2).foregroundStyle(.tertiary)
          }
          Text(verbatim: item.title).font(.callout).lineLimit(2)
          if let dots = item.handedTo, !dots.isEmpty {
            Text(verbatim: "with \(dots.joined(separator: ", "))").font(.caption2).foregroundStyle(.tertiary)
          }
        }
        Button("Reply", action: reply)
          .buttonStyle(.plain)
          .font(.caption.weight(.semibold))
          .opacity(hovering ? 1 : 0.35)
          .accessibilityIdentifier("feed-reply-\(item.id)")
        if let dismiss {
          Button(action: dismiss) {
            Image(systemName: "xmark").font(.caption2.weight(.bold)).padding(4).contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .foregroundStyle(.secondary)
          .opacity(hovering ? 1 : 0.35)
          .accessibilityLabel("Dismiss")
          .accessibilityIdentifier("feed-dismiss-\(item.id)")
        }
      }
      if let error {
        Text("\(error) · click to clear").font(.caption2).foregroundStyle(.red).onTapGesture(perform: clearError)
      }
    }
    .padding(8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 10).fill(.white.opacity(hovering ? 0.1 : 0.05)))
    .contentShape(Rectangle())
    .onHover { hovering = $0 }
    .onTapGesture { openWebLink(item.url) }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("feed-item-\(item.id)")
  }

  private func ago(_ time: Double) -> String {
    let seconds = max(0, Date().timeIntervalSince1970 - time / 1000)
    if seconds < 60 { return "now" }
    if seconds < 3600 { return "\(Int(seconds / 60))m" }
    if seconds < 86400 { return "\(Int(seconds / 3600))h" }
    return "\(Int(seconds / 86400))d"
  }
}

struct SourceMark: View {
  let source: String

  var body: some View {
    Text(source == "github" ? "G" : source == "linear" ? "L" : source == "slack" ? "S" : String(source.prefix(1)).uppercased())
      .font(.system(size: 10, weight: .bold, design: .rounded))
      .frame(width: 18, height: 18)
      .background(RoundedRectangle(cornerRadius: 5).fill(fill))
      .help(source == "github" ? "GitHub" : source == "linear" ? "Linear" : source == "slack" ? "Slack" : source)
  }

  private var fill: Color {
    switch source {
    case "linear": Color.indigo
    case "slack": Color(red: 0.29, green: 0.08, blue: 0.29)
    default: Color.white.opacity(0.2)
    }
  }
}

/// Tapbacks and every other message action live in the message's context menu: a secondary click
/// or Control-click on it, or its "Message actions" accessibility action.
struct MessageRow: View {
  let store: Store
  let dot: String
  let message: Message
  @State private var open = false

  var body: some View {
    switch message.kind {
    case "owner":
      HStack {
        Spacer(minLength: 60)
        VStack(alignment: .trailing, spacing: 2) {
          VStack(alignment: .trailing, spacing: 4) {
            HStack(spacing: 8) {
              replyButton
              MessageActionsButton(id: anchorID)
            }
            if let quote = message.quote { MessageQuoteView(quote: quote, dot: dot) }
            if let item = message.feed { QuoteCard(item: item).frame(maxWidth: 300) }
            if !message.text.isEmpty { Bubble(text: message.text, fill: messageBlue) }
            attachments
          }
          .padding(.bottom, badge == nil ? 0 : 22)
          .overlay(alignment: .bottomTrailing) { reactionBadge }
          .background(menuAnchor)
          .accessibilityElement(children: .contain)
          .accessibilityAction(named: "Message actions") { MenuAnchorView.open(anchorID) }
          .accessibilityIdentifier(anchorID)
          actionError
        }
      }
    case "dot":
      // Without an avatar, the row keeps its earlier stack and alignment.
      if let image = store.avatars.images[dot] {
        HStack(alignment: .top) {
          AvatarView(image: image, size: 22)
          dotMessage
          Spacer(minLength: 60)
        }
      } else {
        HStack {
          dotMessage
          Spacer(minLength: 60)
        }
      }
    default:
      VStack(alignment: .leading, spacing: 2) {
        VStack(alignment: .leading, spacing: 2) {
          HStack(spacing: 8) {
            Text(message.kind == "peer" ? "from \(message.peer ?? "another dot")" : "open-dot")
              .font(.caption2.weight(.semibold))
            MessageActionsButton(id: anchorID)
          }
          if !message.text.isEmpty { Text(message.text).font(.caption).lineLimit(open ? nil : 4) }
          attachments
        }
        .foregroundStyle(.secondary)
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(.white.opacity(0.05)))
        .background(menuAnchor)
        .onTapGesture { open.toggle() }
        .accessibilityElement(children: .contain)
        .accessibilityAction(named: "Message actions") { MenuAnchorView.open(anchorID) }
        .accessibilityIdentifier(anchorID)
        actionError
      }
    }
  }
}

extension MessageRow {
  /// A dot's message and what's under it, beside its avatar when it has one.
  private var dotMessage: some View {
    VStack(alignment: .leading, spacing: 2) {
      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 8) {
          replyButton
          MessageActionsButton(id: anchorID)
        }
        if let quote = message.quote { MessageQuoteView(quote: quote, dot: dot) }
        if !message.text.isEmpty { Bubble(text: message.text, fill: messageGray) }
        attachments
        if let tools = message.tools, !tools.isEmpty {
          Text("used \(tools.joined(separator: ", "))").font(.caption2).foregroundStyle(.tertiary)
        }
      }
      .padding(.bottom, badge == nil ? 0 : 22)
      .overlay(alignment: .bottomTrailing) { reactionBadge }
      .background(menuAnchor)
      .accessibilityElement(children: .contain)
      .accessibilityAction(named: "Message actions") { MenuAnchorView.open(anchorID) }
      .accessibilityIdentifier(anchorID)
      if store.reacting.contains(key) {
        Text("Saving reaction…").font(.caption2).foregroundStyle(.secondary)
      }
      if let error = store.reactionErrors[key] {
        Text(error).font(.caption2).foregroundStyle(.red)
          .accessibilityIdentifier("reaction-error-\(dot)-\(message.id)")
      }
      actionError
    }
  }

  private var replyButton: some View {
    Button("Reply") { store.reply(dot, to: message) }
      .buttonStyle(.plain)
      .font(.caption2)
      .foregroundStyle(.secondary)
      .accessibilityIdentifier("chat-reply-\(dot)-\(message.id)")
  }
  private var key: MessageKey { MessageKey(dot: dot, message: message.id) }

  private var anchorID: String { "message-\(dot)-\(message.id)" }

  /// The menu captures this rendering of the message, so its actions refuse a changed one.
  private var menuAnchor: some View {
    MenuAnchor(id: anchorID, store: store) { anchor in
      messageMenu(store, dot: dot, message: message, anchor: anchor)
    }
  }

  @ViewBuilder private var actionError: some View {
    if let error = store.actionErrors[key] {
      Text("\(error) · click to clear").font(.caption2).foregroundStyle(.red)
        .onTapGesture { store.actionErrors[key] = nil }
        .accessibilityIdentifier("message-error-\(dot)-\(message.id)")
    }
  }

  private var badge: Reaction? {
    message.reactions?.first { $0.actor == (message.kind == "dot" ? "owner" : "dot") && $0.emoji != nil }
  }

  @ViewBuilder private var reactionBadge: some View {
    if let reaction = badge, let emoji = reaction.emoji {
      Text(emoji)
        .font(.system(size: 13))
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(Capsule().fill(messageGray).overlay(Capsule().strokeBorder(.white.opacity(0.3))))
        .accessibilityLabel("\(reaction.actor == "owner" ? "You" : dot) reacted \(emoji)")
        .accessibilityIdentifier("reaction-badge-\(dot)-\(message.id)")
    }
  }

  @ViewBuilder fileprivate var attachments: some View {
    if let items = message.attachments, !items.isEmpty {
      let row = HStack(spacing: 6) {
        ForEach(items, id: \.index) { item in
          AttachmentView(store: store, key: AttachmentKey(dot: dot, message: message.id, index: item.index), item: item)
        }
      }
      // Keeps the row's own alignment when it fits, and scrolls sideways when it doesn't.
      ViewThatFits(in: .horizontal) {
        row
        ScrollView(.horizontal) { row }.scrollIndicators(.never)
      }
    }
  }
}

/// A thumbnail for an image the daemon serves, or a chip with the file's name for anything else.
struct AttachmentView: View {
  let store: Store
  let key: AttachmentKey
  let item: Message.Attachment

  var body: some View {
    let name = item.name.map { ($0 as NSString).lastPathComponent } ?? item.mime
    if item.isImage, let image = store.thumbnails[key] {
      Image(nsImage: image)
        .resizable()
        .scaledToFill()
        .frame(width: 96, height: 72)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .contentShape(Rectangle())
        .onTapGesture { store.openImage(key, title: name) }
        .help(name)
        .accessibilityLabel(name)
        .accessibilityIdentifier("attachment-\(key.message)-\(key.index)")
    } else if item.isImage && !store.unavailable.contains(key) {
      RoundedRectangle(cornerRadius: 8)
        .fill(.white.opacity(0.08))
        .frame(width: 96, height: 72)
        .overlay(ProgressView().controlSize(.small))
        .onAppear { store.loadThumbnail(key) }
    } else {
      // An image that failed to load says so, and a click tries again.
      HStack(spacing: 4) {
        Image(systemName: item.isImage ? "arrow.clockwise" : "doc")
        Text(verbatim: item.isImage ? "\(name) · couldn't load" : name).lineLimit(1)
      }
      .font(.caption2)
      .frame(maxWidth: 200)
      .padding(.horizontal, 8)
      .padding(.vertical, 3)
      .background(Capsule().fill(.white.opacity(0.12)))
      .contentShape(Capsule())
      .onTapGesture { if item.isImage { store.retryThumbnail(key) } }
      .help(item.isImage ? "Click to try again" : name)
      .accessibilityIdentifier("attachment-\(key.message)-\(key.index)")
    }
  }
}

/// Shows an attachment at full size in its own window, capped to the screen.
@MainActor enum ImageWindow {
  /// Drops its image on close, so a large one isn't kept while the window is hidden.
  private final class Window: NSWindow {
    override func close() {
      contentView = nil
      super.close()
    }
  }

  private static var window: NSWindow?

  static func show(_ image: NSImage, title: String) {
    let screen = NSScreen.main?.visibleFrame.size ?? CGSize(width: 1200, height: 800)
    let scale = min(1, screen.width * 0.9 / max(image.size.width, 1), screen.height * 0.9 / max(image.size.height, 1))
    let view = NSImageView(image: image)
    view.imageScaling = .scaleProportionallyUpOrDown
    let window = self.window ?? Window(contentRect: .zero, styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.title = title
    window.contentView = view
    window.setContentSize(CGSize(width: max(image.size.width * scale, 120), height: max(image.size.height * scale, 80)))
    window.center()
    self.window = window
    NSApp.activate()
    window.makeKeyAndOrderFront(nil)
  }
}

struct PendingRow: View {
  let store: Store
  let item: Pending
  let dot: String

  /// "sent" once OpenCode admitted it; it leaves this row when it's delivered into the conversation.
  private var status: String {
    switch item.messageID.flatMap({ store.sendStatus[dot]?[$0] }) {
    case "sent": "sent"
    case "confirming": "confirming…"
    default: "sending…"
    }
  }

  var body: some View {
    let anchorID = "pending-\(dot)-\(item.id)"
    HStack {
      Spacer(minLength: 60)
      VStack(alignment: .trailing, spacing: 3) {
        if let quote = item.quote { MessageQuoteView(quote: quote, dot: dot).opacity(0.6) }
        if let feed = item.feed { QuoteCard(item: feed).frame(maxWidth: 300).opacity(0.6) }
        if !item.text.isEmpty { Bubble(text: item.text, fill: messageBlue).opacity(0.6) }
        if !item.images.isEmpty {
          ScrollView(.horizontal) {
            HStack(spacing: 6) {
              ForEach(item.images) { image in
                Image(nsImage: image.image).resizable().scaledToFill()
                  .frame(width: 64, height: 48).clipped().help(image.name)
              }
            }
          }.frame(maxWidth: 300).frame(height: 48).scrollIndicators(.never).opacity(0.6)
        }
        HStack(spacing: 8) {
          if let error = item.error {
            Text("\(error) · click to dismiss").font(.caption2).foregroundStyle(.red)
          } else {
            Text(status).font(.caption2).foregroundStyle(.tertiary)
          }
          MessageActionsButton(id: anchorID)
        }
      }
      .background(MenuAnchor(id: anchorID, store: store) { pendingMenu(store, dot: dot, item: item, anchor: $0) })
      .accessibilityElement(children: .contain)
      .accessibilityAction(named: "Message actions") { MenuAnchorView.open(anchorID) }
      .accessibilityIdentifier(anchorID)
    }
  }
}

struct MessageQuoteView: View {
  let quote: MessageQuote
  let dot: String

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(verbatim: quote.author == "owner" ? "You" : quote.author == "dot" ? dot : "Slack participant")
        .font(.caption2.weight(.semibold))
      Text(verbatim: quote.text).font(.caption).lineLimit(2)
    }
    .padding(6)
    .frame(maxWidth: 300, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 6).strokeBorder(.white.opacity(0.2)))
    .accessibilityElement(children: .combine)
  }
}

struct Bubble: View {
  let text: String
  let fill: Color

  var body: some View {
    Text(markdown(text))
      .textSelection(.enabled)
      .tint(.white)
      .padding(.horizontal, 10)
      .padding(.vertical, 6)
      .background(RoundedRectangle(cornerRadius: 12).fill(fill))
  }

  private func markdown(_ text: String) -> AttributedString {
    let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
    var string = (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    // Links stay white and underlined, so they read on both bubble colors.
    for run in string.runs where run.link != nil {
      string[run.range].foregroundColor = .white
      string[run.range].underlineStyle = .single
    }
    return string
  }
}

/// Opens a message's menu from the keyboard: with Keyboard Navigation on, Control-Tab out of the
/// message box reaches it, and Space opens the menu. A click opens it too.
struct MessageActionsButton: View {
  let id: String

  var body: some View {
    Button { MenuAnchorView.open(id) } label: {
      Image(systemName: "ellipsis.circle").font(.caption2)
    }
    .buttonStyle(.plain)
    .foregroundStyle(.secondary)
    .help("Message actions")
    .accessibilityLabel("Message actions")
    .accessibilityIdentifier("actions-\(id)")
  }
}

/// Marks a message's content for its context menu. It never takes a click itself: the panel hands
/// it only a secondary click or Control-click, so ordinary clicks, text selection, links and
/// thumbnails keep their own handlers.
struct MenuAnchor: NSViewRepresentable {
  let id: String
  let store: Store
  let menu: (NSView) -> NSMenu

  func makeNSView(context: Context) -> MenuAnchorView { MenuAnchorView() }

  func updateNSView(_ view: MenuAnchorView, context: Context) {
    view.id = id
    view.store = store
    view.makeMenu = menu
  }
}

final class MenuAnchorView: NSView {
  var id = ""
  weak var store: Store?
  var makeMenu: (NSView) -> NSMenu = { _ in NSMenu() }
  private static let anchors = NSHashTable<MenuAnchorView>.weakObjects()

  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    if window == nil { Self.anchors.remove(self) } else { Self.anchors.add(self) }
  }

  /// Opens the menu of the message under a secondary click or Control-click, before the panel's
  /// Quit menu or a text view's own menu can. Returns false for any other event.
  static func handle(_ event: NSEvent) -> Bool {
    guard event.type == .rightMouseDown || (event.type == .leftMouseDown && event.modifierFlags.contains(.control)),
      let anchor = anchors.allObjects.last(where: { $0.contains(event) }) else { return false }
    anchor.popUp(event)
    return true
  }

  /// Opens a message's menu without a click, for VoiceOver's "Message actions".
  static func open(_ id: String) {
    anchors.allObjects.first { $0.id == id }?.popUp(nil)
  }

  /// Only the part of the message left visible by its scroll view counts.
  private func contains(_ event: NSEvent) -> Bool {
    guard window === event.window, !isHiddenOrHasHiddenAncestor else { return false }
    return visibleRect.contains(convert(event.locationInWindow, from: nil))
  }

  /// Both calls return once the menu closes, so the notch is held open just while it's up.
  private func popUp(_ event: NSEvent?) {
    guard let store else { return }
    let menu = makeMenu(self)
    store.hold()
    if let event {
      NSMenu.popUpContextMenu(menu, with: event, for: self)
    } else {
      _ = menu.popUp(positioning: nil, at: NSPoint(x: 0, y: isFlipped ? bounds.maxY : 0), in: self)
    }
    store.release()
  }
}

/// The emoji picker's capture, apart from AppKit. Capturing ends at the first choice, cancel or
/// timeout. The notch's hold is separate: once the picker has been shown, it lasts until focus
/// really leaves the hidden view, which then guards against a late pick from a picker AppKit can't
/// close. Before the picker shows there's nothing to guard, so ending capture releases it too.
struct EmojiCapture: Equatable {
  enum Event: Equatable {
    /// The system picker was opened for this capture.
    case shown
    /// An insertion arrived that counts as the choice.
    case choice
    /// Escape, another editing command, input that isn't an emoji, or the time limit.
    case ended
    /// Focus left the view, the view left its window, the app deactivated or opening failed.
    case focusLost
  }

  struct Effect: Equatable {
    var apply = false
    var release = false
  }

  private(set) var capturing = true
  private(set) var holding = true
  private(set) var shown = false

  mutating func handle(_ event: Event) -> Effect {
    switch event {
    case .shown:
      if capturing { shown = true }
      return Effect()
    case .choice:
      guard capturing else { return Effect() }
      capturing = false
      return Effect(apply: true, release: shown ? false : releaseHold())
    case .ended:
      guard capturing else { return Effect() }
      capturing = false
      return Effect(release: shown ? false : releaseHold())
    case .focusLost:
      capturing = false
      return Effect(release: releaseHold())
    }
  }

  private mutating func releaseHold() -> Bool {
    defer { holding = false }
    return holding
  }
}

/// Takes one choice from the system emoji picker for the message whose menu opened it. It's an
/// ordinary, invisible text view inside that message: it becomes the panel's first responder, and
/// AppKit's `orderFrontCharacterPalette(_:)` opens the picker beside it, which types the chosen emoji
/// through the text input system. The first insertion is the choice and never shows as text.
///
/// AppKit has no public way to close that picker or learn that it closed. So after a choice,
/// Escape, a non-emoji or the time limit, the view keeps the panel's focus and keeps the notch
/// open, dropping any later insertion, and nothing moves focus or folds the notch on its own. That
/// ends only when the owner clicks or tabs elsewhere, switches apps, or the message leaves the
/// panel, or another picker replaces it. A picker still open after that types wherever the owner
/// put focus, such as the message box's draft, never into a reaction.
@MainActor final class EmojiCatcher: NSTextView {
  private static weak var current: EmojiCatcher?
  private static let limit = Duration.seconds(60)
  private var capture = EmojiCapture()
  private var choose: (String) -> Void = { _ in }
  private var report: (String) -> Void = { _ in }
  private weak var store: Store?
  private var waiting: NSObjectProtocol?
  private var leaving: NSObjectProtocol?
  private var timeout: Task<Void, Never>?

  /// The picker's choice goes to `choose`, which keeps the message, dot and session it was opened for.
  static func open(at anchor: NSView, store: Store, choose: @escaping (String) -> Void, report: @escaping (String) -> Void) {
    guard let window = anchor.window else {
      return report("The message scrolled away, so the emoji picker didn't open.")
    }
    let earlier = current
    let catcher = EmojiCatcher(frame: NSRect(x: 0, y: anchor.isFlipped ? 0 : max(0, anchor.bounds.height - 16), width: 2, height: 16))
    catcher.isRichText = false
    catcher.drawsBackground = false
    catcher.insertionPointColor = .clear
    catcher.setAccessibilityLabel("Emoji Tapback")
    catcher.choose = choose
    catcher.report = report
    catcher.store = store
    current = catcher
    // Taken before an earlier picker's hold ends, so the notch doesn't fold in between.
    store.hold()
    anchor.addSubview(catcher)
    catcher.timeout = Task { [weak catcher] in
      try? await Task.sleep(for: limit)
      guard !Task.isCancelled, let catcher else { return }
      catcher.timedOut()
    }
    // The picker types into the active app's focused text, so it opens only once open-dot is active
    // and this view has the panel's focus; otherwise it could type into another app.
    NSApp.activate()
    window.makeKeyAndOrderFront(nil)
    guard window.makeFirstResponder(catcher) else {
      report("The emoji picker couldn't open.")
      catcher.handle(.focusLost)
      return catcher.removeFromSuperview()
    }
    // The earlier view has just lost focus to this one, which released its hold.
    if let earlier, earlier !== catcher { earlier.removeFromSuperview() }
    if NSApp.isActive { return catcher.show() }
    catcher.waiting = NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak catcher] _ in
      MainActor.assumeIsolated { catcher?.show() }
    }
  }

  private func show() {
    stopWaiting()
    guard capture.capturing else { return }
    guard window?.firstResponder === self, NSApp.isActive else { return handle(.ended) }
    // Switching apps is the owner moving focus away, so it ends the guard and lets the notch fold.
    leaving = NotificationCenter.default.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.handle(.focusLost) }
    }
    handle(.shown)
    NSApp.orderFrontCharacterPalette(self)
  }

  private func timedOut() {
    guard capture.capturing else { return }
    report(capture.shown
      ? "No emoji was chosen within a minute, so nothing will be applied. The notch stays open so a late pick can't go astray; click or Tab elsewhere to go on."
      : "The emoji picker didn't open, so nothing was done.")
    handle(.ended)
  }

  /// Applies one lifecycle step. It never moves focus or removes a view, so it's safe from inside
  /// AppKit's own focus changes.
  private func handle(_ event: EmojiCapture.Event, text: String = "") {
    let effect = capture.handle(event)
    if !capture.capturing {
      timeout?.cancel()
      stopWaiting()
    }
    if effect.release {
      if let leaving { NotificationCenter.default.removeObserver(leaving) }
      leaving = nil
      store?.release()
    }
    if effect.apply { choose(text) }
  }

  private func stopWaiting() {
    if let waiting { NotificationCenter.default.removeObserver(waiting) }
    waiting = nil
  }

  /// The picker's choice, or a key typed while it's up. The daemon decides what counts as one emoji;
  /// this only keeps typed letters and digits from being sent at all. Once capture has ended, every
  /// insertion is dropped.
  override func insertText(_ string: Any, replacementRange: NSRange) {
    let text = (string as? NSAttributedString)?.string ?? (string as? String) ?? ""
    guard capture.capturing else {
      if !text.isEmpty { report("The emoji picker had already closed for this message, so nothing was done.") }
      return
    }
    guard looksLikeEmoji(text) else {
      report("Only an emoji can be a Tapback, so nothing was done. Click or Tab elsewhere to go on.")
      return handle(.ended)
    }
    handle(.choice, text: text)
  }

  override func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {}

  /// Escape, Return, arrows and every other editing command end capture with nothing chosen. Tab
  /// and Shift-Tab then move focus on, which ends the guard.
  override func doCommand(by selector: Selector) {
    handle(.ended)
    if selector == #selector(insertTab(_:)) { window?.selectKeyView(following: self) }
    if selector == #selector(insertBacktab(_:)) { window?.selectKeyView(preceding: self) }
  }

  // Nothing is ever pasted or dropped into it.
  override func readSelection(from pboard: NSPasteboard, type: NSPasteboard.PasteboardType) -> Bool { false }

  override func resignFirstResponder() -> Bool {
    let resigned = super.resignFirstResponder()
    if resigned { handle(.focusLost) }
    return resigned
  }

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    if window == nil { handle(.focusLost) }
  }

  override func draw(_ dirtyRect: NSRect) {}
}

/// A menu item's action, run after menu tracking ends so an alert or the share picker never opens
/// inside it. Its item keeps it alive.
@MainActor final class MenuAction: NSObject {
  private let run: () -> Void

  init(_ run: @escaping () -> Void) { self.run = run }

  @objc func fire(_ sender: NSMenuItem) {
    var root = sender.menu
    while let parent = root?.supermenu { root = parent }
    root?.cancelTracking()
    Task { run() }
  }
}

@MainActor private func action(_ title: String, symbol: String?, id: String, enabled: Bool = true, _ run: @escaping () -> Void) -> NSMenuItem {
  let target = MenuAction(run)
  let item = NSMenuItem(title: title, action: #selector(MenuAction.fire(_:)), keyEquivalent: "")
  item.target = target
  item.representedObject = target
  if let symbol { item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil) }
  item.isEnabled = enabled
  item.identifier = NSUserInterfaceItemIdentifier(id)
  item.setAccessibilityIdentifier(id)
  return item
}

/// Why an action is unavailable, as a line in the menu, where VoiceOver reads it too.
@MainActor private func note(_ text: String) -> NSMenuItem {
  let item = NSMenuItem(title: text, action: nil, keyEquivalent: "")
  item.isEnabled = false
  return item
}

/// The classic Tapbacks, in the order of the menu's first row.
private let tapbackNames = [
  ("❤️", "Heart"), ("👍", "Thumbs Up"), ("👎", "Thumbs Down"), ("😂", "Ha Ha"), ("‼️", "Exclamation Marks"), ("❓", "Question Mark"),
]

/// The second row until the owner has chosen five non-classic emoji, as the daemon fills it.
let fallbackTapbacks = ["🧐", "✋", "👀", "🧠", "🔥"]

/// The menu's second row, always five: the daemon's latest non-classic choices, newest first, then
/// fallbacks not already shown, as the daemon fills it. An older daemon sends none.
func recentTapbacks(_ recent: [String]) -> [String] {
  let used = Array(recent.prefix(5))
  return Array((used + fallbackTapbacks.filter { !used.contains($0) }).prefix(5))
}

/// The owner's current reaction when neither row shows it, such as an older choice that has left
/// the recent five. The menu lists it on its own, checked, so it can still be seen and removed.
func unlistedTapback(_ selected: String?, row: [String]) -> String? {
  guard let selected, !tapbackNames.contains(where: { $0.0 == selected }), !row.contains(selected) else { return nil }
  return selected
}

/// A quick local check that text is one character drawn as an emoji, before the daemon's exact
/// one. It turns away typed letters, digits and symbols shown as text, such as a bare ❤ or 1.
func looksLikeEmoji(_ text: String) -> Bool {
  text.count == 1 && text.unicodeScalars.contains {
    $0.properties.isEmojiPresentation || $0.properties.isEmojiModifier || $0 == "\u{FE0F}"
  }
}

/// A row of Tapbacks as AppKit's inline palette: standard menu items shown in place of the item
/// that holds them, so arrow keys, Return, VoiceOver and the selected state all work, which a
/// custom view in a menu can't offer. The selected one is drawn on the accent color.
@MainActor private func tapbackRow(_ emojis: [(String, String)], selected: String?, enabled: Bool, id: String, choose: @escaping (String) -> Void) -> NSMenu {
  let palette = NSMenu(title: "Tapback")
  palette.presentationStyle = .palette
  palette.autoenablesItems = false
  for (emoji, name) in emojis {
    let item = action(name, symbol: nil, id: "tapback-\(id)-\(emoji)", enabled: enabled) { choose(emoji) }
    item.image = tapbackImage(emoji, selected: selected == emoji)
    item.state = selected == emoji ? .on : .off
    item.toolTip = selected == emoji ? "Remove your \(name)" : name
    item.setAccessibilityLabel(selected == emoji ? "\(name), selected. Remove your Tapback" : "\(name) Tapback")
    palette.addItem(item)
  }
  return palette
}

@MainActor private func paletteItem(_ palette: NSMenu, id: String) -> NSMenuItem {
  let row = NSMenuItem(title: palette.title, action: nil, keyEquivalent: "")
  row.submenu = palette
  row.identifier = NSUserInterfaceItemIdentifier(id)
  row.setAccessibilityIdentifier(id)
  return row
}

/// The six classic Tapbacks.
@MainActor private func tapbacks(selected: String?, enabled: Bool, id: String, choose: @escaping (String) -> Void) -> NSMenuItem {
  paletteItem(tapbackRow(tapbackNames, selected: selected, enabled: enabled, id: id, choose: choose), id: "message-menu-tapbacks")
}

/// The owner's five recent emoji, then a smiley that opens the system emoji picker. VoiceOver
/// reads each emoji's own name.
@MainActor private func moreTapbacks(_ row: [String], selected: String?, enabled: Bool, id: String, choose: @escaping (String) -> Void, pick: @escaping () -> Void) -> NSMenuItem {
  let palette = tapbackRow(row.map { ($0, $0) }, selected: selected, enabled: enabled, id: id, choose: choose)
  palette.title = "More Tapbacks"
  let picker = action("Choose Emoji…", symbol: nil, id: "tapback-\(id)-picker", enabled: enabled, pick)
  picker.image = NSImage(systemSymbolName: "face.smiling", accessibilityDescription: nil)?
    .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 20, weight: .regular))
  picker.toolTip = "Choose any emoji"
  picker.setAccessibilityLabel("Choose any emoji as a Tapback")
  palette.addItem(picker)
  return paletteItem(palette, id: "message-menu-recent-tapbacks")
}

private func tapbackImage(_ emoji: String, selected: Bool) -> NSImage {
  // AppKit may draw the image off the main thread, so the handler uses only its own values.
  NSImage(size: NSSize(width: 36, height: 32), flipped: false) { @Sendable rect in
    if selected {
      NSColor.controlAccentColor.setFill()
      NSBezierPath(roundedRect: rect, xRadius: 9, yRadius: 9).fill()
    }
    let glyph = NSAttributedString(string: emoji, attributes: [.font: NSFont.systemFont(ofSize: 22)])
    let size = glyph.size()
    glyph.draw(at: NSPoint(x: rect.midX - size.width / 2, y: rect.midY - size.height / 2))
    return true
  }
}

/// A delivered message's menu. Every action keeps the dot, message and session it was opened for,
/// and refuses rather than act on a message that has changed since.
@MainActor func messageMenu(_ store: Store, dot: String, message: Message, anchor: NSView) -> NSMenu {
  let key = MessageKey(dot: dot, message: message.id)
  let session = message.sessionID
  let menu = NSMenu()
  menu.autoenablesItems = false
  let selected = message.reactions?.first { $0.actor == "owner" }?.emoji
  let reactable = message.kind == "dot" && !store.reacting.contains(key)
  // Every choice, including one from the emoji picker long after, goes to this message in this session.
  let choose = { (emoji: String) -> Void in
    guard store.stillShown(key, session: session) != nil else { return }
    if store.reacting.contains(key) {
      return store.report("A reaction to this message is still saving, so nothing was done.", dot: dot, key: key)
    }
    store.react(key, emoji: emoji)
  }
  menu.addItem(tapbacks(selected: selected, enabled: reactable, id: "\(dot)-\(message.id)", choose: choose))
  let row = recentTapbacks(store.recentEmojis)
  menu.addItem(moreTapbacks(row, selected: selected, enabled: reactable, id: "\(dot)-\(message.id)", choose: choose) { [weak anchor] in
    guard store.stillShown(key, session: session) != nil else { return }
    guard let anchor else {
      return store.report("The message scrolled away, so the emoji picker didn't open.", dot: dot, key: key)
    }
    EmojiCatcher.open(at: anchor, store: store, choose: choose) { store.report($0, dot: dot, key: key) }
  })
  if let current = unlistedTapback(selected, row: row) {
    // Choosing the selected emoji removes it, as in the rows.
    let item = action("Your Tapback: \(current)", symbol: nil, id: "tapback-\(dot)-\(message.id)-current", enabled: reactable) { choose(current) }
    item.state = .on
    item.toolTip = "Remove your \(current)"
    item.setAccessibilityLabel("\(current), selected. Remove your Tapback")
    menu.addItem(item)
  }
  menu.addItem(.separator())
  let reacted = message.reactions?.contains { $0.emoji != nil } ?? false
  menu.addItem(action("Tapback Details…", symbol: "info.circle", id: "message-menu-details", enabled: reacted) {
    if let current = store.stillShown(key, session: session) { showDetails(current, dot: dot, store: store) }
  })
  let repliable = message.kind == "owner" || message.kind == "dot"
  menu.addItem(action("Reply…", symbol: "arrowshape.turn.up.left", id: "message-menu-reply", enabled: repliable) {
    if let current = store.stillShown(key, session: session) { store.reply(dot, to: current) }
  })
  menu.addItem(.separator())
  let content = !message.text.isEmpty || message.attachments?.contains(where: \.isImage) == true
  menu.addItem(action("Copy", symbol: "doc.on.doc", id: "message-menu-copy", enabled: content) {
    store.copy(key, session: session)
  })
  menu.addItem(action("Share…", symbol: "square.and.arrow.up", id: "message-menu-share", enabled: content) { [weak anchor] in
    guard let anchor else {
      return store.report("The message scrolled away, so nothing was shared.", dot: dot, key: key)
    }
    store.share(key, session: session, from: anchor)
  })
  menu.addItem(.separator())
  menu.addItem(action("Delete…", symbol: "trash", id: "message-menu-delete", enabled: session != nil && !store.hiding.contains(key)) {
    if let session { confirmHide(key, session: session, store: store) }
  })
  let reasons = [
    message.kind == "dot" ? nil : "Tapbacks are only for \(dot)'s messages.",
    repliable ? nil : "Reply is only for your messages and \(dot)'s.",
    content ? nil : "There's no text or image to copy or share.",
    session == nil ? "Delete needs the updated open-dot daemon." : nil,
  ].compactMap { $0 }
  if !reasons.isEmpty { menu.addItem(.separator()) }
  for reason in reasons { menu.addItem(note(reason)) }
  return menu
}

/// A message not yet delivered can only be copied, and shared when it has no images: it keeps just
/// their previews. Reactions, replies and Delete need the delivered message.
@MainActor func pendingMenu(_ store: Store, dot: String, item: Pending, anchor: NSView) -> NSMenu {
  let menu = NSMenu()
  menu.autoenablesItems = false
  let text = item.text
  menu.addItem(action("Copy", symbol: "doc.on.doc", id: "message-menu-copy", enabled: !text.isEmpty) {
    Store.copyText(text)
  })
  menu.addItem(action("Share…", symbol: "square.and.arrow.up", id: "message-menu-share", enabled: !text.isEmpty && item.images.isEmpty) { [weak anchor] in
    // A refusal shows above the message box, since a pending bubble has no error line of its own.
    store.present([text], dot: dot, key: nil, from: anchor)
  })
  menu.addItem(.separator())
  menu.addItem(note("Tapbacks, Reply and Delete wait until it's delivered."))
  if !item.images.isEmpty { menu.addItem(note("Its images copy and share once delivered.")) }
  return menu
}

/// Runs an alert while holding the notch open, so it doesn't fold away behind it.
@MainActor func runAlert(_ alert: NSAlert, _ store: Store) -> NSApplication.ModalResponse {
  store.hold()
  defer { store.release() }
  NSApp.activate()
  return alert.runModal()
}

@MainActor private func showDetails(_ message: Message, dot: String, store: Store) {
  let lines = (message.reactions ?? [])
    .sorted { $0.actor == "owner" && $1.actor != "owner" }
    .compactMap { reaction in reaction.emoji.map { "\(reaction.actor == "owner" ? "You" : dot): \($0)" } }
  let alert = NSAlert()
  alert.messageText = "Tapback Details"
  alert.informativeText = lines.isEmpty ? "No Tapbacks." : lines.joined(separator: "\n")
  alert.addButton(withTitle: "OK")
  _ = runAlert(alert, store)
}

/// The one confirmation before a stop: what happens, with Cancel first for Return and Escape.
func stopConfirmation(_ worker: Dot.Worker, dot: String) -> (title: String, detail: String) {
  (
    "Stop worker #\(worker.id)?",
    "\(worker.task)\n\nIts current run is interrupted, and nothing already queued for it is sent. \(dot) hears once that you stopped it. A message you type in its session later can resume it."
  )
}

@MainActor private func confirmStop(_ worker: Dot.Worker, dot: String, store: Store) {
  let text = stopConfirmation(worker, dot: dot)
  let alert = NSAlert()
  alert.messageText = text.title
  alert.informativeText = text.detail
  alert.addButton(withTitle: "Cancel")
  alert.addButton(withTitle: "Stop").hasDestructiveAction = true
  guard runAlert(alert, store) == .alertSecondButtonReturn else { return }
  store.stopWorker(worker)
}

@MainActor private func confirmHide(_ key: MessageKey, session: String, store: Store) {
  let alert = NSAlert()
  alert.messageText = "Delete this message from the notch?"
  alert.informativeText = "This only hides it in the notch, and it stays hidden after a restart. \(key.dot) still remembers it: its conversation, memory, Tapbacks and Slack don't change."
  // Cancel comes first, so Return and Escape both keep the message.
  alert.addButton(withTitle: "Cancel")
  alert.addButton(withTitle: "Delete").hasDestructiveAction = true
  guard runAlert(alert, store) == .alertSecondButtonReturn else { return }
  store.hide(key, session: session)
}
