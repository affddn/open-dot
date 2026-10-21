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
        tabs
        if store.showingFeed {
          FeedList(store: store)
        } else if let status = store.status {
          centered(status)
        } else if let name = store.selected, let dot = store.dots.first(where: { $0.name == name }) {
          Conversation(store: store, name: name)
            .id(name)
          if !dot.workers.isEmpty { workers(dot.workers) }
          composer(name)
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
              Text(dot.name).font(.callout.weight(.medium))
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

  private func workers(_ workers: [Dot.Worker]) -> some View {
    ScrollView(.horizontal) {
      HStack(spacing: 6) {
        ForEach(workers, id: \.id) { worker in
          Text("#\(worker.id) \(worker.state) · \(worker.task)")
            .font(.caption2)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .frame(maxWidth: 220)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Capsule().fill(.white.opacity(0.08)))
        }
      }
    }
    .scrollIndicators(.hidden)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("workers")
  }

  private func composer(_ name: String) -> some View {
    Composer(placeholder: "Message \(name)", text: Binding { store.drafts[name] ?? "" } set: { store.drafts[name] = $0 }) {
      store.send()
    }
    .id(name)
  }
}

struct Composer: View {
  let placeholder: String
  @Binding var text: String
  var canSend = true
  let send: () -> Void
  @State private var height: CGFloat = 22

  var body: some View {
    let blocked = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !canSend
    HStack(alignment: .bottom) {
      DraftEditor(text: $text, height: $height, placeholder: placeholder, send: send)
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
  let send: () -> Void

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  func makeNSView(context: Context) -> NSScrollView {
    let scroll = NSScrollView()
    scroll.drawsBackground = false
    scroll.hasVerticalScroller = true
    let editor = DraftTextView()
    editor.isRichText = false
    editor.drawsBackground = false
    editor.textColor = .white
    editor.font = .systemFont(ofSize: 13)
    editor.textContainerInset = NSSize(width: 0, height: 3)
    editor.isVerticallyResizable = true
    editor.autoresizingMask = [.width]
    editor.textContainer?.widthTracksTextView = true
    editor.delegate = context.coordinator
    editor.setAccessibilityIdentifier("composer")
    scroll.documentView = editor
    return scroll
  }

  func updateNSView(_ scroll: NSScrollView, context: Context) {
    context.coordinator.parent = self
    guard let editor = scroll.documentView as? DraftTextView else { return }
    editor.send = send
    editor.setAccessibilityLabel(placeholder)
    if editor.string != text { editor.string = text }
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

  override func keyDown(with event: NSEvent) {
    if (event.keyCode == 36 || event.keyCode == 76) && !hasMarkedText() {
      if !event.modifierFlags.intersection([.shift, .option]).isEmpty {
        insertNewline(nil)
      } else if !string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
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
    let messages = store.messages[name] ?? []
    let pending = store.pending[name] ?? []
    ScrollViewReader { proxy in
      ScrollView {
        // Lazy, so a thumbnail loads only when its message scrolls into view.
        LazyVStack(alignment: .leading, spacing: 8) {
          ForEach(messages) { MessageRow(store: store, dot: name, message: $0) }
          ForEach(pending) { item in
            PendingRow(item: item).onTapGesture {
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
      Text("Nothing needs you right now.").foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
    } else {
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

struct MessageRow: View {
  let store: Store
  let dot: String
  let message: Message
  @State private var open = false
  @State private var hovering = false
  @State private var pickerOpen = false

  var body: some View {
    switch message.kind {
    case "owner":
      HStack {
        Spacer(minLength: 60)
        VStack(alignment: .trailing, spacing: 4) {
          if let item = message.feed { QuoteCard(item: item).frame(maxWidth: 300) }
          if !message.text.isEmpty { Bubble(text: message.text, fill: messageBlue) }
          attachments
        }
        .padding(.bottom, badge == nil ? 0 : 22)
        .overlay(alignment: .bottomTrailing) { reactionBadge }
      }
    case "dot":
      HStack {
        VStack(alignment: .leading, spacing: 0) {
          picker
            .frame(height: 32)
            .opacity(hovering || pickerOpen ? 1 : 0)
            .allowsHitTesting(hovering || pickerOpen)
            .accessibilityHidden(!(hovering || pickerOpen))
          VStack(alignment: .leading, spacing: 3) {
            if !message.text.isEmpty { Bubble(text: message.text, fill: messageGray) }
            attachments
            if let tools = message.tools, !tools.isEmpty {
              Text("used \(tools.joined(separator: ", "))").font(.caption2).foregroundStyle(.tertiary)
            }
          }
          .padding(.bottom, badge == nil ? 0 : 22)
          .overlay(alignment: .bottomTrailing) { reactionBadge }
          if store.reacting.contains(key) {
            Text("Saving reaction…").font(.caption2).foregroundStyle(.secondary)
          }
          if let error = store.reactionErrors[key] {
            Text(error).font(.caption2).foregroundStyle(.red)
              .accessibilityIdentifier("reaction-error-\(dot)-\(message.id)")
          }
        }
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .accessibilityAction(named: "React") { pickerOpen.toggle() }
        Spacer(minLength: 60)
      }
    default:
      VStack(alignment: .leading, spacing: 2) {
        Text(message.kind == "peer" ? "from \(message.peer ?? "another dot")" : "open-dot")
          .font(.caption2.weight(.semibold))
        if !message.text.isEmpty { Text(message.text).font(.caption).lineLimit(open ? nil : 4) }
        attachments
      }
      .foregroundStyle(.secondary)
      .padding(8)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: 8).fill(.white.opacity(0.05)))
      .onTapGesture { open.toggle() }
    }
  }
}

extension MessageRow {
  private var key: ReactionKey { ReactionKey(dot: dot, message: message.id) }

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

  private var picker: some View {
    let selected = message.reactions?.first(where: { $0.actor == "owner" })?.emoji
    return HStack(spacing: 2) {
      ForEach(["❤️", "👍", "👎", "😂", "‼️", "❓"], id: \.self) { emoji in
        Button { store.react(key, emoji: emoji) } label: {
          Text(emoji).font(.system(size: 16))
            .frame(width: 28, height: 26)
            .background(RoundedRectangle(cornerRadius: 6).fill(selected == emoji ? messageBlue : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(store.reacting.contains(key))
        .accessibilityLabel(selected == emoji ? "Remove your \(emoji) reaction" : "React \(emoji)")
        .accessibilityAddTraits(selected == emoji ? .isSelected : [])
        .accessibilityIdentifier("react-\(dot)-\(message.id)-\(emoji)")
      }
    }
    .padding(.horizontal, 3)
    .background(Capsule().fill(messageGray))
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
  let item: Pending

  var body: some View {
    HStack {
      Spacer(minLength: 60)
      VStack(alignment: .trailing, spacing: 3) {
        if let feed = item.feed { QuoteCard(item: feed).frame(maxWidth: 300).opacity(0.6) }
        Bubble(text: item.text, fill: messageBlue).opacity(0.6)
        if let error = item.error {
          Text("\(error) · click to dismiss").font(.caption2).foregroundStyle(.red)
        } else {
          Text(item.messageID == nil ? "sending…" : "queued").font(.caption2).foregroundStyle(.tertiary)
        }
      }
    }
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
