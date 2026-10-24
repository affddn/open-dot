import AppKit
import SwiftUI

/// A dot's Slack app as the daemon's `GET /dots/<name>/slack` gives it, the same state as
/// `open-dot slack status`. It never holds a token.
struct SlackSetup: Decodable, Equatable {
  struct Config: Decodable, Equatable {
    /// "idle", "rotating" or "blocked".
    let state: String
    var problem: String? = nil
    /// Whether open-dot once saved or rotated a pair, not that one is in the Keychain now. Nil
    /// from an older daemon.
    var saved: Bool? = nil
  }

  /// What the owner's own Slack feed saved, apart from any dot's bot, from the daemon's database.
  struct OwnerFeed: Decodable, Equatable {
    let items: Int
    var latestAt: Double? = nil
  }

  /// An owner-started DM check: "pending", or "replied" once a reply Slack confirmed is saved.
  struct DMCheck: Decodable, Equatable {
    let state: String
    let since: Double
    var dmAt: Double? = nil
  }

  struct Icon: Decodable, Equatable {
    /// "no-avatar", "set", "pending", "setting", "waiting" or "refused".
    let status: String
    /// Slack's error code for a refusal or a wait.
    var error: String? = nil
    var retryAt: Double? = nil
  }

  /// The daemon's install with the Slack login: "queued", "sending", "saved", "approval" or
  /// "failed", with Slack's error code or open-dot's own (`unknown_outcome`, `bad_answer`,
  /// `save_failed`).
  struct Install: Decodable, Equatable {
    let phase: String
    var code: String? = nil
  }

  /// The owner's Slack login, once per workspace, as the daemon last saw it. Never a token.
  struct Login: Decodable, Equatable {
    struct Pending: Decodable, Equatable {
      let attempt: String
      let expiresAt: Double
    }

    /// "unknown", "none", "ready" or "relogin".
    let state: String
    var team: String? = nil
    var user: String? = nil
    var problem: String? = nil
    var pending: Pending? = nil
  }

  struct App: Decodable, Equatable {
    let state: String
    var appID: String? = nil
    var botUser: String? = nil
    var problem: String? = nil
    /// Nil from an older daemon, and for an app the daemon wasn't asked to install.
    var install: Install? = nil
    let manifestOutdated: Bool
    var updateState: String? = nil
    var updateNote: String? = nil
    /// Only for a created or active app.
    var icon: Icon? = nil
  }

  let config: Config
  var app: App? = nil
  var ownerFeed: OwnerFeed? = nil
  var dmCheck: DMCheck? = nil
  /// Nil from a daemon older than the login.
  var login: Login? = nil
  /// Slack's prefilled link for a new app from the dot's manifest.
  var manifestLink: String? = nil
}

/// A login's slash command, waiting in the notch's memory for the owner's challenge code.
struct SlackLoginTicket: Decodable, Equatable {
  let attempt: String
  let command: String
  let expiresAt: Double
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
  /// Starts, or restarts, a DM check. It sends nothing to Slack.
  case dmCheck
  /// Asks the daemon for a login's slash command, then exchanges it once with Slack's code.
  case loginStart
  case loginFinish(attempt: String, challenge: String)
  /// The owner's Retry install of the created app with the Slack login.
  case install
  /// Binds the app whose two tokens these are, such as one made from the prefilled link. It takes
  /// the place of the dot's current app only with `replacing`, the ID of the app the owner
  /// confirmed replacing; the daemon refuses it once another app is bound.
  case link(bot: String, app: String, replacing: String?)
}

/// What the daemon answered an action.
enum SlackOutcome: Equatable {
  case view(SlackSetup)
  case saved
  case said(String)
  /// The manifest update's changes, waiting for the owner's approval. Nothing was sent.
  case confirm([String])
  /// A login waiting for its challenge code.
  case ticket(SlackLoginTicket)
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
    && (url.path == "/apps" || url.path.hasPrefix("/apps/"))
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

/// Whether the view offers the Slack login: a daemon that has it, and no usable login.
func slackNeedsLogin(_ setup: SlackSetup) -> Bool {
  guard let login = setup.login else { return false }
  return login.state != "ready"
}

/// Where the Slack login stands, in the owner's words.
func slackLoginLine(_ login: SlackSetup.Login) -> String {
  switch login.state {
  case "ready": return "Logged in to Slack\(login.team.map { " in \($0)" } ?? ""). Install creates and installs each dot's app with it."
  case "relogin": return "Log in to Slack again: \(login.problem ?? "the saved login can't be used.")"
  case "none": return "Not logged in to Slack. Log in once for this workspace, and Install does the rest."
  default: return "Log in to Slack once for this workspace, and Install creates and installs each dot's app. If you logged in before, the daemon finds it when it next needs it."
  }
}

/// What the daemon's install with the Slack login says now, or nil when it wasn't asked.
func slackInstallLine(_ install: SlackSetup.Install?) -> String? {
  guard let install else { return nil }
  switch install.phase {
  case "queued", "sending": return "The daemon is installing the app with your Slack login."
  case "saved": return "Installed with your Slack login, and both tokens are in the Keychain. Saved isn't connected: this says Connected once the daemon has checked them."
  case "approval":
    return install.code == "app_approval_request_eligible"
      ? "Waiting for admin approval. open-dot hasn't asked for it: request approval on the app's install page, then Retry install once an admin approves."
      : install.code == "app_approval_request_pending"
        ? "Waiting for admin approval: the request is with your workspace's admins. Retry install once one approves."
        : "An admin denied this app. Ask your admins, then Retry install."
  default:
    return "Installing didn't finish (\(install.code ?? "slack_error")). Retry install, or install the same app yourself below."
  }
}

/// Whether Retry install is offered: a created app with nothing in flight, and a usable login.
func slackCanRetryInstall(_ setup: SlackSetup) -> Bool {
  guard let app = setup.app, app.state == "created", setup.login?.state == "ready" else { return false }
  return app.install?.phase != "queued" && app.install?.phase != "sending"
}

/// The prefilled link, only while it's one of Slack's app pages.
func slackManifestURL(_ setup: SlackSetup) -> URL? {
  guard let text = setup.manifestLink, let url = URL(string: text), isSlackAppPage(url) else { return nil }
  return url
}

/// The app an app-level token names, as `xapp-<n>-<app ID>-…`.
func slackLinkAppID(_ token: String) -> String? {
  guard let match = token.firstMatch(of: /^xapp-[0-9]{1,4}-(A[A-Z0-9]{6,31})-/) else { return nil }
  return String(match.1)
}

/// What the prefilled link warns before it's used: it always makes another app.
func slackLinkWarning(_ app: SlackSetup.App?, dot: String) -> String {
  let base = "The prefilled link makes a new app in Slack each time you use it."
  guard let app else { return base }
  if let id = app.appID, app.state == "created" || app.state == "active" {
    return "\(base) \(dot) already has the app \(id): another would be a duplicate, and binding it replaces \(id) only once you confirm. \(id) stays in Slack until you delete it."
  }
  if app.state == "unknown" {
    return "\(base) Creating \(dot)'s app got no clear answer, so one may already exist at api.slack.com/apps; look there first."
  }
  return base
}

/// The app's ID and state in a line, or that there's none.
func slackTitle(_ app: SlackSetup.App?) -> String {
  guard let app else { return "No app" }
  return "App \(app.appID ?? "") · \(app.state)"
}

/// The app's state and the owner's next step, in the words `open-dot slack status` uses.
func slackSummary(_ setup: SlackSetup, dot: String) -> String {
  guard let app = setup.app else {
    return "\(dot) has no Slack app of its own. Install asks the daemon to create one named \(dot) and install it with your Slack login. Without a login, use the prefilled link below."
  }
  switch app.state {
  case "requested":
    return "Requested. The daemon creates the app with your Slack login, or your configuration token, within about 10 seconds."
  case "creating": return "The daemon is creating the app now."
  case "unknown":
    return "Creating the app got no clear answer, so it may exist. Look for an app named \(dot) at api.slack.com/apps and attach its ID, or create it again with Retry."
  case "attaching": return "The daemon is checking that app with Slack."
  case "failed": return "Slack refused to create the app. Try again with Install."
  case "created":
    if let line = slackInstallLine(app.install) { return "Created. \(line)" }
    return "Created. Install it in Slack (Install, then Allow), then save its bot token and an app-level token with the connections:write scope, by pickup or in the fields. Saved isn't connected: the daemon checks them within a minute and connects."
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

/// The time of a daemon timestamp in milliseconds, as the notch shows it.
private func shortTime(_ milliseconds: Double) -> String {
  Date(timeIntervalSince1970: milliseconds / 1000).formatted(date: .abbreviated, time: .shortened)
}

/// The owner's own Slack feed as open-dot saved it, apart from the dot's bot. Nothing is checked
/// live, so this never says the feed works now.
func slackOwnerFeedLine(_ feed: SlackSetup.OwnerFeed?) -> String {
  let what = "Your own Slack feed (the shared open-dot app, with your user token) is separate from this bot."
  guard let feed else { return "\(what) This daemon doesn't report it." }
  guard feed.items > 0, let latest = feed.latestAt else {
    return "\(what) open-dot has saved no Slack items from it. This view doesn't check its token; Health shows its last pass."
  }
  return "\(what) open-dot has saved \(feed.items) Slack items from it, the newest from \(shortTime(latest)). This view doesn't check its token; Health shows its last pass."
}

/// Whether the workspace still needs its configuration pair: none saved yet, or rotation blocked.
func slackNeedsConfig(_ setup: SlackSetup) -> Bool {
  setup.config.saved != true || setup.config.state == "blocked"
}

/// Where an owner-started DM check stands. Only a reply Slack confirmed counts, never a queued one.
func slackDMCheckLine(_ check: SlackSetup.DMCheck?, dot: String) -> String {
  guard let check else {
    return "DM check: not started. Start it, then send \(dot) a DM in Slack yourself. Nothing is sent for you."
  }
  if check.state == "replied", let at = check.dmAt {
    return "DM check: \(dot) replied in Slack to your DM from \(shortTime(at)), as open-dot's saved record of its posted reply shows."
  }
  return "DM check: pending since \(shortTime(check.since)). Send \(dot) a DM in Slack yourself; this changes only once Slack confirmed its reply. A queued reply doesn't count, and restarting the daemon forgets the check."
}

/// A token the guided install picks up from the clipboard, one step at a time. `linkBot` and
/// `linkApp` are the two tokens of an app the owner made from the prefilled link, whose ID the
/// app-level token names.
enum SlackPickupStep: String, Equatable {
  case access, refresh, bot, app, linkBot, linkApp

  var name: String {
    switch self {
    case .access: "configuration access token"
    case .refresh: "configuration refresh token"
    case .bot, .linkBot: "bot token"
    case .app, .linkApp: "app-level token"
    }
  }

  /// The step whose token is held in memory until this one's arrives.
  var after: SlackPickupStep? {
    switch self {
    case .refresh: .access
    case .linkApp: .linkBot
    default: nil
    }
  }
}

/// Whether `text` is exactly one token of the step's form, anchored at both ends. An app-level
/// token names its app, so it must name this one.
func slackTokenMatches(_ step: SlackPickupStep, _ text: String, appID: String?) -> Bool {
  let pattern: String
  switch step {
  case .access: pattern = #"\Axoxe\.xoxp-[0-9]{1,4}-[A-Za-z0-9]{20,1000}\z"#
  case .refresh: pattern = #"\Axoxe-[0-9]{1,4}-[A-Za-z0-9]{20,1000}\z"#
  case .bot, .linkBot: pattern = #"\Axoxb-[0-9]{1,20}-[0-9]{1,20}-[A-Za-z0-9]{20,64}\z"#
  case .app:
    guard let appID, slackLinks(appID) != nil else { return false }
    pattern = #"\Axapp-[0-9]{1,4}-"# + appID + #"-[0-9]{1,20}-[A-Za-z0-9]{20,128}\z"#
  case .linkApp: pattern = #"\Axapp-[0-9]{1,4}-A[A-Z0-9]{6,31}-[0-9]{1,20}-[A-Za-z0-9]{20,128}\z"#
  }
  return text.utf8.count <= 1024 && text.range(of: pattern, options: .regularExpression) != nil
}

/// The clipboard as a pickup reads it. Tests pass a fake, so they never touch the system one.
@MainActor protocol Clipboard: AnyObject {
  var revision: Int { get }
  func text() -> String?
  /// Clears it only while it still holds that revision, leaving any later copy alone.
  func clear(revision: Int)
}

@MainActor final class SystemClipboard: Clipboard {
  nonisolated init() {}
  var revision: Int { NSPasteboard.general.changeCount }
  func text() -> String? { NSPasteboard.general.string(forType: .string) }
  func clear(revision: Int) {
    guard NSPasteboard.general.changeCount == revision else { return }
    NSPasteboard.general.clearContents()
  }
}

/// The one armed pickup: its dot, step and app, the clipboard revision last looked at, and when it
/// ends. It holds no clipboard text.
struct SlackPickup: Equatable {
  let dot: String
  let step: SlackPickupStep
  let appID: String?
  var seen: Int
  let deadline: TimeInterval
  var mismatched = false
}

/// An access token picked up and held in memory only until its refresh token is, or a link's
/// bot token until its app-level token is.
struct HeldAccess {
  let dot: String
  var step: SlackPickupStep = .access
  let token: String
  var deadline: TimeInterval
}

extension Store {
  static let pickupSeconds: TimeInterval = 120

  /// Whether the dot's Slack view is what the owner has open, folded or not.
  func slackShown(_ name: String) -> Bool {
    selected == name && showingSlack && !showingFeed && dots.contains { $0.name == name }
  }

  /// Arms the one pickup, for this dot's step, replacing any other. Only copies made from now on
  /// count. A refresh pickup needs this dot's access token held; any other step drops one.
  func armPickup(_ name: String, _ step: SlackPickupStep) {
    guard slackShown(name), !slackBusy.contains(name) else { return }
    var appID: String?
    switch step {
    case .bot, .app:
      guard let app = slackStates[name]?.app, app.state == "created" || app.state == "active",
        slackLinks(app.appID) != nil
      else { return }
      appID = app.appID
    case .refresh, .linkApp:
      guard let held = heldAccess, held.dot == name, held.step == step.after, uptime() < held.deadline else {
        endPickup(nil)
        slackNotices[name] = "Pick up the \(step == .refresh ? "access" : "bot") token first."
        return
      }
    case .access, .linkBot: break
    }
    let deadline = uptime() + Self.pickupSeconds
    if step.after == nil { dropHeldAccess() }
    slackPickup = SlackPickup(dot: name, step: step, appID: appID, seen: clipboard.revision, deadline: deadline)
    slackNotices[name] = nil
    pickupGeneration += 1
    let generation = pickupGeneration
    Task { [weak self] in
      while let store = self, store.pickupGeneration == generation, store.slackPickup != nil || store.heldAccess != nil {
        store.checkPickup()
        try? await Task.sleep(for: .milliseconds(250))
      }
    }
  }

  func stopPickup() { endPickup("Pickup stopped. Nothing was kept.") }

  /// Ends the pickup and drops a held access token, telling the dot's view why.
  func endPickup(_ said: String?) {
    let dot = slackPickup?.dot ?? heldAccess?.dot
    slackPickup = nil
    dropHeldAccess()
    pickupGeneration += 1
    if let dot, let said { slackNotices[dot] = said }
  }

  private func dropHeldAccess() {
    heldAccess = nil
    slackHolding = nil
  }

  /// One look at the clipboard for the armed pickup. The pickup ends on leaving the dot's Slack
  /// view, a new app, or its two minutes. A new copy is read once: one that isn't exactly the
  /// step's token is dropped unkept, and the token is taken, its copy cleared, and saved through
  /// the same daemon route as the secure fields, once, never again on its own.
  func checkPickup() {
    let now = uptime()
    let left = "Pickup stopped when you left the dot's Slack view. Nothing was kept."
    if let held = heldAccess {
      if !slackShown(held.dot) { return endPickup(left) }
      if now >= held.deadline {
        return endPickup(held.step == .linkBot
          ? "The app-level token wasn't picked up within 2 minutes, so the bot token was dropped. Nothing was saved."
          : "The refresh token wasn't picked up within 2 minutes, so the access token was dropped. Nothing was saved.")
      }
    }
    guard let pickup = slackPickup else { return }
    if !slackShown(pickup.dot) { return endPickup(left) }
    if let appID = pickup.appID, slackStates[pickup.dot]?.app?.appID != appID {
      return endPickup("The dot's app changed, so the pickup stopped. Nothing was kept.")
    }
    if now >= pickup.deadline {
      return endPickup("No \(pickup.step.name) was copied within 2 minutes, so the pickup stopped. Nothing was kept.")
    }
    guard !slackBusy.contains(pickup.dot) else { return }
    let revision = clipboard.revision
    guard revision != pickup.seen else { return }
    slackPickup?.seen = revision
    let copied = clipboard.text() ?? ""
    guard clipboard.revision == revision else { return }
    guard slackTokenMatches(pickup.step, copied, appID: pickup.appID) else {
      slackPickup?.mismatched = true
      return
    }
    clipboard.clear(revision: revision)
    slackPickup = nil
    switch pickup.step {
    case .access:
      heldAccess = HeldAccess(dot: pickup.dot, token: copied, deadline: now + Self.pickupSeconds)
      slackHolding = pickup.dot
      slackNotices[pickup.dot] = "Access token picked up and held in the notch's memory only. Pick up the refresh token within 2 minutes; nothing is saved until both are."
    case .linkBot:
      heldAccess = HeldAccess(dot: pickup.dot, step: .linkBot, token: copied, deadline: now + Self.pickupSeconds)
      slackHolding = pickup.dot
      slackNotices[pickup.dot] = "Bot token picked up and held in the notch's memory only. Pick up the app-level token within 2 minutes; nothing is saved until both are."
    case .refresh, .linkApp:
      guard let held = heldAccess, held.dot == pickup.dot, held.step == pickup.step.after else { return endPickup(nil) }
      endPickup(nil)
      if pickup.step == .refresh {
        runSlack(pickup.dot, .config(token: held.token, refreshToken: copied))
      } else {
        link(pickup.dot, bot: held.token, app: copied)
      }
    case .bot, .app:
      endPickup(nil)
      runSlack(pickup.dot, .token(kind: pickup.step.rawValue, token: copied))
    }
  }

  /// Binds the app these tokens belong to. One that isn't the dot's created or active app takes
  /// its place only once the owner confirms, and the request names the very app the owner saw
  /// and confirmed replacing, so the daemon refuses it if another is bound by then.
  func link(_ name: String, bot: String, app: String) {
    let current = slackStates[name]?.app
    var replacing: String?
    if let current, let id = current.appID, current.state == "created" || current.state == "active",
      slackLinkAppID(app) != id
    {
      guard confirmSlackReplace(name, id) else {
        slackNotices[name] = "Nothing was saved. \(name) keeps the app \(id)."
        return
      }
      replacing = id
    }
    runSlack(name, .link(bot: bot, app: app, replacing: replacing))
  }

  /// Asks the daemon for a login's slash command. The ticket stays only in the notch's memory.
  func startLogin(_ name: String) {
    slackTicket = nil
    runSlack(name, .loginStart)
  }

  /// Sends the challenge code once. The login is used up whatever the answer, so it's forgotten.
  func finishLogin(_ name: String, challenge: String) {
    guard let ticket = slackTicket else { return }
    slackTicket = nil
    runSlack(name, .loginFinish(attempt: ticket.attempt, challenge: challenge))
  }

  /// The owner's own mark that Slack asked an admin to approve the app. Nothing detects approval.
  func markApproval(_ name: String, waiting: Bool) {
    guard let appID = slackStates[name]?.app?.appID else { return }
    if waiting { slackApproval.insert(appID) } else { slackApproval.remove(appID) }
  }

  /// Opens the same app's install page again, once the owner says an admin approved it.
  func resumeInstall(_ name: String) {
    guard let appID = slackStates[name]?.app?.appID, let links = slackLinks(appID) else { return }
    slackApproval.remove(appID)
    openSlack(links.install)
  }

  func openSlack(_ url: URL) {
    guard isSlackAppPage(url) else { return }
    openSlackPage(url)
  }
}

/// A dot's Slack app, reached from its tab's menu under Connectors: the state and the next step as
/// buttons. Tokens picked up or typed here go once to the daemon, which saves them in the
/// Keychain, and the fields are cleared.
struct SlackView: View {
  let store: Store
  let name: String
  @State private var accessToken = ""
  @State private var refreshToken = ""
  @State private var botToken = ""
  @State private var appToken = ""
  @State private var appID = ""
  @State private var challenge = ""
  @State private var linkBot = ""
  @State private var linkApp = ""

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
          // The first dot in a workspace needs the Slack login before Install can do it all.
          if slackNeedsLogin(setup), let login = setup.login { loginSection(login) }
          state(setup)
          if let app = setup.app, app.state == "active" { conversation(setup, app) }
          if setup.app?.state != "active" { linkSection(setup) }
          if let login = setup.login, !slackNeedsLogin(setup) { loginSection(login) }
          // Configuration tokens are the advanced path: the manifest update and the icon use them.
          // A daemon older than the login has only them.
          if setup.login == nil {
            configSection(setup)
          } else {
            DisclosureGroup("Advanced: configuration tokens") { configSection(setup) }
              .font(.caption2).accessibilityIdentifier("slack-advanced")
          }
          Text("Pickup is off until you press Pick up. It then watches the clipboard for 2 minutes for that one token, takes only a copy made after you pressed it that is exactly that token, clears that copy, and stops when you leave this view. A clipboard manager or Universal Clipboard may keep its own copy. You can type or paste into the secure fields instead.")
            .font(.caption2).foregroundStyle(.secondary).accessibilityIdentifier("slack-pickup-disclosure")
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
        Button("Install") { store.runSlack(name, .connect(retry: false)) }
          .accessibilityIdentifier("slack-create")
      case "unknown"?:
        // Like `slack connect --retry`: only once the owner says no app exists.
        Button("Retry create…") { store.retryCreate(name) }
          .accessibilityIdentifier("slack-retry")
      default:
        EmptyView()
      }
      if slackCanAttach(app?.state) { attach }
      if slackCanRetryInstall(setup) {
        Button(app?.install == nil ? "Install with Slack login" : "Retry install") { store.runSlack(name, .install) }
          .accessibilityIdentifier("slack-retry-install")
      }
      if let app, app.state == "created" || app.state == "active", let links = slackLinks(app.appID) {
        if app.state == "active" || app.install?.phase != "saved" { installSteps(app, links) }
        if slackCanUpdate(app) {
          Button("Update manifest…") { store.runSlack(name, .update(approve: nil)) }
            .accessibilityIdentifier("slack-update")
        }
        if let icon = app.icon {
          Text(verbatim: slackIconLine(icon, dot: name)).font(.caption2).textSelection(.enabled)
            .accessibilityIdentifier("slack-icon")
          if icon.status == "refused" { Button("Open App settings") { store.openSlack(links.general) } }
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

  /// Install, approval and the two tokens, in Slack's order.
  @ViewBuilder private func installSteps(_ app: SlackSetup.App, _ links: SlackLinks) -> some View {
    let appID = app.appID ?? ""
    let saved = store.slackSaved[appID] ?? []
    step("1. Install it in Slack: review what it asks for, then Allow. If Slack says an admin must approve it, request approval and mark it here.")
    if store.slackApproval.contains(appID) {
      Text("Waiting for admin approval, as you marked it. open-dot doesn't see approvals, so nothing here changes on its own. Once an admin approves, resume.")
        .font(.caption2).foregroundStyle(.orange).accessibilityIdentifier("slack-approval-waiting")
      HStack {
        Button("Resume installation") { store.resumeInstall(name) }.accessibilityIdentifier("slack-resume")
        Button("Clear mark") { store.markApproval(name, waiting: false) }
      }
    } else {
      HStack {
        Button("Install in Slack") { store.openSlack(links.install) }.accessibilityIdentifier("slack-install")
        Button("Waiting for admin approval") { store.markApproval(name, waiting: true) }
          .accessibilityIdentifier("slack-approval")
      }
    }
    step("2. On OAuth & Permissions, Copy the Bot User OAuth Token.\(saved.contains("bot") ? " Saved." : "")")
    HStack {
      Button("Open OAuth page") { store.openSlack(links.oauth) }.accessibilityIdentifier("slack-oauth")
      pickupButton(.bot)
    }
    tokenField("Bot token (xoxb-…)", text: $botToken, kind: "bot")
    step("3. On Basic Information under App-Level Tokens, Generate Token and Scopes, add connections:write, Generate, then Copy.\(saved.contains("app") ? " Saved." : "")")
    HStack {
      Button("Open App-Level Tokens") { store.openSlack(links.general) }.accessibilityIdentifier("slack-general")
      pickupButton(.app)
    }
    tokenField("App-level token (xapp-…)", text: $appToken, kind: "app")
    pickupStatus([.bot, .app])
    if app.state == "created" && saved.isSuperset(of: ["bot", "app"]) {
      step("Both tokens are saved in the Keychain. Saved isn't connected: the daemon checks them within a minute, and this says Connected only once it has.")
    }
  }

  private func step(_ text: String) -> some View {
    Text(verbatim: text).font(.caption2).textSelection(.enabled)
  }

  private func pickupButton(_ step: SlackPickupStep) -> some View {
    let armed = store.slackPickup?.dot == name && store.slackPickup?.step == step
    let title = armed ? "Stop pickup" : "Pick up \(step.name)"
    return Button(title) {
      if armed { store.stopPickup() } else { store.armPickup(name, step) }
    }
    .accessibilityIdentifier("slack-pickup-\(step.rawValue)")
  }

  /// What the armed pickup waits for, under its own steps.
  @ViewBuilder private func pickupStatus(_ steps: [SlackPickupStep]) -> some View {
    if let pickup = store.slackPickup, pickup.dot == name, steps.contains(pickup.step) {
      Text(verbatim: "Waiting up to 2 minutes for you to Copy the \(pickup.step.name) in Slack.\(pickup.mismatched ? " The last copy wasn't one, so it was ignored and not kept." : "")")
        .font(.caption2).foregroundStyle(.orange).accessibilityIdentifier("slack-pickup-status")
    }
  }

  /// The bot's identity, apart from the owner's own feed, where to talk to it, and the DM check.
  private func conversation(_ setup: SlackSetup, _ app: SlackSetup.App) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("Talking to \(name) in Slack").font(.caption.weight(.medium))
      step("Bot: \(app.botUser.map { "<@\($0)>" } ?? "not known yet") in \(name)'s own app \(app.appID ?? ""). It speaks only as \(name).")
      step(slackOwnerFeedLine(setup.ownerFeed))
      step("DM \(name) from its Messages tab or agent view in Slack. In a channel, /invite @\(name), then mention it; for a private channel, invite it from inside that channel. It sees only conversations it's in, and answers only you.")
      step(slackDMCheckLine(setup.dmCheck, dot: name)).accessibilityIdentifier("slack-dm-check")
      Button(setup.dmCheck == nil ? String("Start DM check") : "Restart DM check") { store.runSlack(name, .dmCheck) }
        .accessibilityIdentifier("slack-dm-check-start")
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

  /// The owner's Slack login, once per workspace: a slash command to run in Slack, then the code
  /// Slack shows. The command and code stay in the notch's memory until sent once.
  private func loginSection(_ login: SlackSetup.Login) -> some View {
    let ticket = store.slackTicket.flatMap { $0.expiresAt > Date().timeIntervalSince1970 * 1000 ? $0 : nil }
    return VStack(alignment: .leading, spacing: 6) {
      Text("Slack login").font(.caption.weight(.medium)).accessibilityIdentifier("slack-login-heading")
      step(slackLoginLine(login)).accessibilityIdentifier("slack-login-line")
      if let ticket {
        step("1. Run this in any Slack channel or DM, then approve it:")
        Text(verbatim: ticket.command).font(.caption2.monospaced()).textSelection(.enabled)
          .accessibilityIdentifier("slack-login-command")
        Button("Copy command") { store.copyText(ticket.command) }.accessibilityIdentifier("slack-login-copy")
        step("2. Enter the code Slack shows. It's sent once; a wrong one needs a new login.")
        HStack {
          SecureField("Challenge code", text: $challenge).textFieldStyle(.roundedBorder)
          Button("Finish login") {
            let code = challenge.trimmingCharacters(in: .whitespacesAndNewlines)
            challenge = ""
            store.finishLogin(name, challenge: code)
          }
          .disabled(challenge.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          .accessibilityIdentifier("slack-login-finish")
        }
      } else {
        Button(login.state == "ready" ? "Log in again" : "Log in to Slack") { store.startLogin(name) }
          .accessibilityIdentifier("slack-login-start")
      }
    }
    .buttonStyle(.plain)
    .font(.caption2.weight(.semibold))
    .padding(8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 10).fill(.white.opacity(0.05)))
  }

  /// The fallback when Install can't: Slack's prefilled link for a new app, then its two tokens,
  /// which the daemon checks with Slack before binding that app.
  private func linkSection(_ setup: SlackSetup) -> some View {
    let holding = store.slackHolding == name && store.heldAccess?.step == .linkBot
    return VStack(alignment: .leading, spacing: 6) {
      Text("Or create it yourself").font(.caption.weight(.medium)).accessibilityIdentifier("slack-link-heading")
      step(slackLinkWarning(setup.app, dot: name)).foregroundStyle(.orange).accessibilityIdentifier("slack-link-warning")
      step("Open the prefilled link, pick the workspace and Create. Install it to the workspace, then copy the Bot User OAuth Token from OAuth & Permissions, and under Basic Information generate an app-level token with connections:write.")
      HStack {
        if let url = slackManifestURL(setup) {
          Button("Open prefilled link") { store.openSlack(url) }.accessibilityIdentifier("slack-link-open")
        }
        pickupButton(.linkBot)
        pickupButton(.linkApp).disabled(!holding)
      }
      if holding {
        Text("Bot token held in memory only, until the app-level token is picked up.")
          .font(.caption2).foregroundStyle(.orange).accessibilityIdentifier("slack-link-holding")
      }
      pickupStatus([.linkBot, .linkApp])
      SecureField("Bot token (xoxb-…)", text: $linkBot).textFieldStyle(.roundedBorder)
      SecureField("App-level token (xapp-…)", text: $linkApp).textFieldStyle(.roundedBorder)
      Button("Connect this app") {
        let bot = linkBot.trimmingCharacters(in: .whitespacesAndNewlines)
        let app = linkApp.trimmingCharacters(in: .whitespacesAndNewlines)
        linkBot = ""
        linkApp = ""
        store.link(name, bot: bot, app: app)
      }
      .disabled(linkBot.isEmpty || linkApp.isEmpty)
      .accessibilityIdentifier("slack-link-save")
    }
    .buttonStyle(.plain)
    .font(.caption2.weight(.semibold))
    .padding(8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 10).fill(.white.opacity(0.05)))
  }

  /// The configuration token pair: the first dot in a workspace needs it, later dots reuse it.
  private func configSection(_ setup: SlackSetup) -> some View {
    let first = slackNeedsConfig(setup)
    let holding = store.slackHolding == name && store.heldAccess?.step == .access
    let heading = first ? "Configuration tokens, not saved yet" : "Configuration tokens, saved for this workspace"
    let guide = first
      ? "Optional with the Slack login. Manifest updates and setting the app's icon use them, and Install falls back to them without a login: open Your App Configuration Tokens, Generate Token for the workspace, then pick up the access token and then the refresh token. The daemon rotates the saved pair before each use."
      : "open-dot saved a pair before and rotates it before each use. Replace the pair only if it's blocked."
    return VStack(alignment: .leading, spacing: 6) {
      Text(verbatim: heading).font(.caption.weight(.medium)).accessibilityIdentifier("slack-config-heading")
      Text(verbatim: guide).font(.caption2).foregroundStyle(.secondary)
      if setup.config.state == "blocked" {
        Text(verbatim: setup.config.problem ?? "Rotation is blocked. Save a new pair.")
          .font(.caption2).foregroundStyle(.orange).textSelection(.enabled)
      }
      HStack {
        if let page = URL(string: "https://api.slack.com/apps") {
          Button("Open configuration tokens") { store.openSlack(page) }.accessibilityIdentifier("slack-config-page")
        }
        pickupButton(.access)
        pickupButton(.refresh).disabled(!holding)
      }
      if holding {
        Text("Access token held in memory only, until the refresh token is picked up.")
          .font(.caption2).foregroundStyle(.orange).accessibilityIdentifier("slack-holding")
      }
      pickupStatus([.access, .refresh])
      SecureField("Access token (xoxe.xoxp-…)", text: $accessToken).textFieldStyle(.roundedBorder)
      SecureField("Refresh token (xoxe-…)", text: $refreshToken).textFieldStyle(.roundedBorder)
      Button("Save configuration tokens") {
        let token = accessToken.trimmingCharacters(in: .whitespacesAndNewlines)
        let refresh = refreshToken.trimmingCharacters(in: .whitespacesAndNewlines)
        accessToken = ""
        refreshToken = ""
        store.runSlack(name, .config(token: token, refreshToken: refresh))
      }
      .disabled(accessToken.isEmpty || refreshToken.isEmpty)
      .accessibilityIdentifier("slack-save-config")
    }
    .buttonStyle(.plain)
    .font(.caption2.weight(.semibold))
    .padding(8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 10).fill(.white.opacity(0.05)))
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

/// Asks the owner before another app takes the place of the dot's current one. The current app
/// stays in Slack; only open-dot forgets it.
@MainActor func confirmReplace(_ name: String, _ appID: String, _ store: Store) -> Bool {
  let alert = NSAlert()
  alert.messageText = "Replace \(name)'s Slack app?"
  alert.informativeText = "\(name) is bound to the app \(appID). These tokens belong to another app, which would take its place, and open-dot would forget \(appID)'s bot. \(appID) stays in Slack until you delete it there."
  alert.addButton(withTitle: "Replace it")
  alert.addButton(withTitle: "Cancel")
  return runAlert(alert, store) == .alertFirstButtonReturn
}
