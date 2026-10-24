import AppKit
import SwiftUI

/// A dot's Slack app as the daemon's `GET /dots/<name>/slack` gives it, the same state as
/// `open-dot slack status`. It never holds a token.
struct SlackSetup: Decodable, Equatable {
  struct Config: Decodable, Equatable {
    /// "idle", "rotating" or "blocked".
    let state: String
    var problem: String? = nil
  }

  struct Icon: Decodable, Equatable {
    /// "no-avatar", "set", "pending", "setting", "waiting" or "refused".
    let status: String
    /// Slack's error code for a refusal or a wait.
    var error: String? = nil
    var retryAt: Double? = nil
  }

  struct App: Decodable, Equatable {
    let state: String
    var appID: String? = nil
    var botUser: String? = nil
    var problem: String? = nil
    let manifestOutdated: Bool
    var updateState: String? = nil
    var updateNote: String? = nil
    /// Only for a created or active app.
    var icon: Icon? = nil
  }

  let config: Config
  var app: App? = nil
}

/// What the owner asks of a dot's Slack app from the notch. Each is sent once, never retried.
enum SlackAction: Equatable {
  case config(token: String, refreshToken: String)
  case connect(retry: Bool)
  case attach(String)
  case token(kind: String, token: String)
  /// With nil, the daemon answers with the changes to approve; with them, it sends exactly those.
  case update(approve: [String]?)
  case icon
}

/// What the daemon answered an action.
enum SlackOutcome: Equatable {
  case view(SlackSetup)
  case saved
  case said(String)
  /// The manifest update's changes, waiting for the owner's approval. Nothing was sent.
  case confirm([String])
}

/// The app's pages on api.slack.com, built only from an app ID of Slack's form.
struct SlackLinks: Equatable {
  let install: URL
  let general: URL
  let oauth: URL
}

func slackLinks(_ appID: String?) -> SlackLinks? {
  guard let appID, appID.range(of: "^A[A-Z0-9]{6,31}$", options: .regularExpression) != nil else { return nil }
  let base = "https://api.slack.com/apps/\(appID)"
  guard let install = URL(string: "\(base)/install-on-team"),
    let general = URL(string: "\(base)/general"),
    let oauth = URL(string: "\(base)/oauth")
  else { return nil }
  return SlackLinks(install: install, general: general, oauth: oauth)
}

/// Whether a URL is one of Slack's app pages, the only kind the Slack view opens.
func isSlackAppPage(_ url: URL) -> Bool {
  url.scheme == "https" && url.host == "api.slack.com" && url.user == nil && url.port == nil
    && url.path.hasPrefix("/apps/")
}

/// Whether the owner may name an existing app for the dot: with no app yet, or one requested,
/// refused or whose creation got no clear answer, as `open-dot slack attach` allows.
func slackCanAttach(_ state: String?) -> Bool {
  state == nil || ["requested", "failed", "unknown", "attaching"].contains(state ?? "")
}

/// Whether Update manifest is offered: for an older manifest, and to settle an update that failed,
/// got no clear answer, or left a note such as a reinstall, as `open-dot slack update` does.
func slackCanUpdate(_ app: SlackSetup.App) -> Bool {
  app.manifestOutdated || app.updateState != nil || app.updateNote != nil
}

/// The app's ID and state in a line, or that there's none.
func slackTitle(_ app: SlackSetup.App?) -> String {
  guard let app else { return "No app" }
  return "App \(app.appID ?? "") · \(app.state)"
}

/// The app's state and the owner's next step, in the words `open-dot slack status` uses.
func slackSummary(_ setup: SlackSetup, dot: String) -> String {
  guard let app = setup.app else {
    return "\(dot) has no Slack app of its own. Create one: the daemon makes it from a manifest with your configuration token."
  }
  switch app.state {
  case "requested":
    return "Requested. The daemon creates the app with your configuration token within about 10 seconds."
  case "creating": return "The daemon is creating the app now."
  case "unknown":
    return "Creating the app got no clear answer, so it may exist. Look for an app named \(dot) at api.slack.com/apps and attach its ID, or create it again with Retry."
  case "attaching": return "The daemon is checking that app with Slack."
  case "failed": return "Slack refused to create the app. Try again with Create."
  case "created":
    return "Created. Install it in Slack (Install, then Allow), generate an app-level token with the connections:write scope under App-Level Tokens, then save both tokens below. The daemon checks them within a minute and connects."
  case "active":
    return "Connected\(app.botUser.map { " as <@\($0)>" } ?? ""). Invite it to a channel with /invite @\(dot), then mention it there, or DM it."
  default: return "State: \(app.state)."
  }
}

/// Where the app's icon stands, and the manual upload once Slack refused it.
func slackIconLine(_ icon: SlackSetup.Icon, dot: String) -> String {
  switch icon.status {
  case "no-avatar":
    return "\(dot) has no avatar yet. Set one with open-dot avatar \(dot) <file>, and the daemon sets it as the app's icon."
  case "set": return "Icon set from the avatar."
  case "setting": return "The daemon is setting the icon from the avatar now."
  case "waiting":
    return "Slack is rate limiting icon changes. The daemon tries again on its own once Slack allows."
  case "refused" where icon.error == "unknown_outcome":
    return "Setting the icon got no clear answer (unknown_outcome), so it may have worked, and it's never sent again on its own. Check the icon in Slack. If it isn't the avatar, set it yourself: open App settings, scroll to Display Information, upload the avatar under App icon & Preview, then click Save Changes. Or Retry icon."
  case "refused":
    return "Slack refused to set the icon (\(icon.error ?? "slack_error")). Set it yourself: open App settings, scroll to Display Information, upload the avatar under App icon & Preview, then click Save Changes. Or Retry icon."
  default: return "The daemon sets the icon from the avatar within a minute or two."
  }
}

/// A dot's Slack app, reached from its tab's menu: the state and the next step as buttons. Tokens
/// typed here go once to the daemon, which saves them in the Keychain, and the fields are cleared.
struct SlackView: View {
  let store: Store
  let name: String
  @State private var accessToken = ""
  @State private var refreshToken = ""
  @State private var botToken = ""
  @State private var appToken = ""
  @State private var appID = ""

  var body: some View {
    let setup = store.slackStates[name]
    let busy = store.slackBusy.contains(name)
    ScrollView {
      VStack(alignment: .leading, spacing: 10) {
        if let error = store.slackErrors[name] {
          Text(error).font(.caption2).foregroundStyle(.red).accessibilityIdentifier("slack-error")
        }
        if let notice = store.slackNotices[name] {
          Text(verbatim: notice).font(.caption2).foregroundStyle(.orange).textSelection(.enabled)
            .accessibilityIdentifier("slack-notice")
        }
        if let setup {
          state(setup)
          configSection(setup)
        } else {
          Text("Loading…").foregroundStyle(.secondary)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .disabled(busy)
    }
    .scrollIndicators(.never)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("slack-\(name)")
  }

  @ViewBuilder private func state(_ setup: SlackSetup) -> some View {
    let app = setup.app
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text(verbatim: slackTitle(app))
          .font(.caption.weight(.medium))
        Spacer()
      }
      Text(verbatim: slackSummary(setup, dot: name)).font(.caption2).foregroundStyle(.secondary)
        .textSelection(.enabled)
      if let problem = app?.problem {
        Text(verbatim: "Problem: \(problem)").font(.caption2).foregroundStyle(.orange).textSelection(.enabled)
      }
      if let note = app?.updateNote {
        Text(verbatim: "Manifest update: \(note)").font(.caption2).textSelection(.enabled)
      }
      switch app?.state {
      case nil, "failed"?:
        Button("Create app") { store.runSlack(name, .connect(retry: false)) }
          .accessibilityIdentifier("slack-create")
      case "unknown"?:
        // Like `slack connect --retry`: only once the owner says no app exists.
        Button("Retry create…") { store.retryCreate(name) }
          .accessibilityIdentifier("slack-retry")
      default:
        EmptyView()
      }
      if slackCanAttach(app?.state) { attach }
      if let app, app.state == "created" || app.state == "active", let links = slackLinks(app.appID) {
        HStack {
          Button("Open install page") { openPage(links.install) }.accessibilityIdentifier("slack-install")
          Button("Open App-Level Tokens") { openPage(links.general) }.accessibilityIdentifier("slack-general")
          Button("Open OAuth page") { openPage(links.oauth) }.accessibilityIdentifier("slack-oauth")
        }
        tokenField("Bot token (xoxb-…)", text: $botToken, kind: "bot")
        tokenField("App-level token (xapp-…)", text: $appToken, kind: "app")
        if slackCanUpdate(app) {
          Button("Update manifest…") { store.runSlack(name, .update(approve: nil)) }
            .accessibilityIdentifier("slack-update")
        }
        if let icon = app.icon {
          Text(verbatim: slackIconLine(icon, dot: name)).font(.caption2).textSelection(.enabled)
            .accessibilityIdentifier("slack-icon")
          if icon.status == "refused" { Button("Open App settings") { openPage(links.general) } }
          if icon.status != "no-avatar" {
            Button("Retry icon") { store.runSlack(name, .icon) }.accessibilityIdentifier("slack-icon-retry")
          }
        }
      }
    }
    .buttonStyle(.plain)
    .font(.caption2.weight(.semibold))
    .padding(8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 10).fill(.white.opacity(0.05)))
  }

  private var attach: some View {
    HStack {
      TextField("App ID (A…)", text: $appID).textFieldStyle(.roundedBorder).frame(maxWidth: 160)
      Button("Attach") {
        let id = appID.trimmingCharacters(in: .whitespaces)
        appID = ""
        store.runSlack(name, .attach(id))
      }
      .disabled(appID.trimmingCharacters(in: .whitespaces).isEmpty)
      .accessibilityIdentifier("slack-attach")
    }
  }

  private func tokenField(_ label: String, text: Binding<String>, kind: String) -> some View {
    HStack {
      SecureField(label, text: text).textFieldStyle(.roundedBorder)
      Button("Save") {
        let token = text.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines)
        text.wrappedValue = ""
        store.runSlack(name, .token(kind: kind, token: token))
      }
      .disabled(text.wrappedValue.isEmpty)
      .accessibilityIdentifier("slack-save-\(kind)")
    }
  }

  private func configSection(_ setup: SlackSetup) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("Configuration tokens, once per workspace").font(.caption.weight(.medium))
      Text("Generate a pair at api.slack.com/apps under Your App Configuration Tokens. The daemon rotates it before each use.")
        .font(.caption2).foregroundStyle(.secondary)
      if setup.config.state == "blocked" {
        Text(verbatim: setup.config.problem ?? "Rotation is blocked. Save a new pair.")
          .font(.caption2).foregroundStyle(.orange).textSelection(.enabled)
      }
      SecureField("Access token (xoxe.xoxp-…)", text: $accessToken).textFieldStyle(.roundedBorder)
      SecureField("Refresh token (xoxe-…)", text: $refreshToken).textFieldStyle(.roundedBorder)
      Button("Save configuration tokens") {
        let token = accessToken.trimmingCharacters(in: .whitespacesAndNewlines)
        let refresh = refreshToken.trimmingCharacters(in: .whitespacesAndNewlines)
        accessToken = ""
        refreshToken = ""
        store.runSlack(name, .config(token: token, refreshToken: refresh))
      }
      .buttonStyle(.plain)
      .font(.caption2.weight(.semibold))
      .disabled(accessToken.isEmpty || refreshToken.isEmpty)
      .accessibilityIdentifier("slack-save-config")
    }
    .padding(8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 10).fill(.white.opacity(0.05)))
  }

  private func openPage(_ url: URL) {
    guard isSlackAppPage(url) else { return }
    NSWorkspace.shared.open(url)
  }
}

/// Asks the owner to say no app named after the dot exists before creating it again, as
/// `open-dot slack connect --retry` does.
@MainActor func confirmNoApp(_ name: String, _ store: Store) -> Bool {
  let alert = NSAlert()
  alert.messageText = "Create \(name)'s Slack app again?"
  alert.informativeText = "Creating it got no clear answer, so it may exist. Only continue if you checked api.slack.com/apps and there's no app named \(name). If there is one, attach its ID instead."
  alert.addButton(withTitle: "There's no app, create it")
  alert.addButton(withTitle: "Cancel")
  return runAlert(alert, store) == .alertFirstButtonReturn
}

/// Asks the owner to approve exactly these manifest changes, as `open-dot slack update` does.
@MainActor func approveUpdate(_ name: String, _ changes: [String], _ store: Store) -> Bool {
  let alert = NSAlert()
  alert.messageText = "Update \(name)'s Slack app?"
  alert.informativeText = "This adds to its manifest, keeping everything else in it:\n\n"
    + changes.joined(separator: "\n")
  alert.addButton(withTitle: "Update")
  alert.addButton(withTitle: "Cancel")
  return runAlert(alert, store) == .alertFirstButtonReturn
}
