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
          if store.dots.contains(where: \.busy) { BusyDot() }
          Spacer()
          if store.feedUnread || store.dots.contains(where: { store.unread($0.name) }) { UnreadDot() }
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
      if let status = store.status {
        centered(status)
      } else if !store.loaded {
        centered("Connecting…")
      } else {
        tabs
        if store.showingFeed {
          FeedList(store: store)
        } else if let name = store.selected, let dot = store.dots.first(where: { $0.name == name }) {
          Conversation(store: store, name: name)
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
    let empty = (store.drafts[name] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    return HStack {
      TextField("Message \(name)", text: Binding { store.drafts[name] ?? "" } set: { store.drafts[name] = $0 })
        .textFieldStyle(.plain)
        .onSubmit { store.send() }
        .accessibilityIdentifier("composer")
        .id(name)
      Button { store.send() } label: {
        Image(systemName: "arrow.up.circle.fill").font(.title2)
      }
      .buttonStyle(.plain)
      .disabled(empty)
      .opacity(empty ? 0.4 : 1)
      .accessibilityLabel("Send")
      .accessibilityIdentifier("send")
    }
    .padding(.leading, 12)
    .padding(.trailing, 6)
    .padding(.vertical, 6)
    .background(RoundedRectangle(cornerRadius: 14).fill(.white.opacity(0.08)))
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
        VStack(alignment: .leading, spacing: 8) {
          ForEach(messages) { MessageRow(message: $0) }
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

  var body: some View {
    let items = store.feed
    if items.isEmpty {
      Text("Nothing needs you right now.").foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
    } else {
      GeometryReader { viewport in
        ScrollViewReader { proxy in
          ScrollView {
            VStack(spacing: 6) {
              ForEach(items) { item in
                FeedRow(item: item, error: store.feedErrors[item.id]) {
                  store.dismissFeed(item)
                } clearError: {
                  store.clearFeedError(item.id)
                }
              }
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
}

struct FeedRow: View {
  let item: FeedItem
  let error: String?
  let dismiss: () -> Void
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
        }
        Button(action: dismiss) {
          Image(systemName: "xmark").font(.caption2.weight(.bold)).padding(4).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .opacity(hovering ? 1 : 0.35)
        .accessibilityLabel("Dismiss")
        .accessibilityIdentifier("feed-dismiss-\(item.id)")
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
    .onTapGesture { open() }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("feed-item-\(item.id)")
  }

  /// Feed links come from outside, so only web links open.
  private func open() {
    guard let link = item.url, let url = URL(string: link), ["http", "https"].contains(url.scheme?.lowercased()) else { return }
    NSWorkspace.shared.open(url)
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
    Text(source == "github" ? "G" : source == "linear" ? "L" : String(source.prefix(1)).uppercased())
      .font(.system(size: 10, weight: .bold, design: .rounded))
      .frame(width: 18, height: 18)
      .background(RoundedRectangle(cornerRadius: 5).fill(source == "linear" ? Color.indigo : Color.white.opacity(0.2)))
      .help(source == "github" ? "GitHub" : source == "linear" ? "Linear" : source)
  }
}

struct MessageRow: View {
  let message: Message
  @State private var open = false

  var body: some View {
    switch message.kind {
    case "owner":
      HStack {
        Spacer(minLength: 60)
        Bubble(text: message.text, fill: messageBlue)
      }
    case "dot":
      HStack {
        VStack(alignment: .leading, spacing: 3) {
          if !message.text.isEmpty { Bubble(text: message.text, fill: messageGray) }
          if let tools = message.tools, !tools.isEmpty {
            Text("used \(tools.joined(separator: ", "))").font(.caption2).foregroundStyle(.tertiary)
          }
        }
        Spacer(minLength: 60)
      }
    default:
      VStack(alignment: .leading, spacing: 2) {
        Text(message.kind == "peer" ? "from \(message.peer ?? "another dot")" : "open-dot")
          .font(.caption2.weight(.semibold))
        Text(message.text).font(.caption).lineLimit(open ? nil : 4)
      }
      .foregroundStyle(.secondary)
      .padding(8)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: 8).fill(.white.opacity(0.05)))
      .onTapGesture { open.toggle() }
    }
  }
}

struct PendingRow: View {
  let item: Pending

  var body: some View {
    HStack {
      Spacer(minLength: 60)
      VStack(alignment: .trailing, spacing: 3) {
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
