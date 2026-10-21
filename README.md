# open-dot

A durable personal agent built on OpenCode V2. You give a dot a name and a purpose, reopen its conversation from anywhere, and it follows up on its own time.

OpenCode provides the model, tools, permissions and chat. open-dot adds identity, continuity and timing. See [docs/PLAN.md](docs/PLAN.md) for the design and milestones.

> Status: early. Milestones 1 (a dot you can open), 2 (it follows up), 3 (it delegates), 4 (dots talk to each other) and 5 (the notch app) are done.

## Use it

Install dependencies with `bun install --frozen-lockfile`, then add open-dot to `plugins` in your OpenCode config. One entry loads both the server plugin and the TUI plugin:

```jsonc
{
  "plugins": [{ "package": "/path/to/open-dot" }],
}
```

Then create and open a dot:

```sh
bun src/cli.ts create jojo "Keep me on top of my week."
bun src/cli.ts list
bun src/cli.ts open jojo
```

In the OpenCode TUI, `/dot [name]` opens a dot too, and the sidebar lists your dots and their recent workers. A dot saves notes, schedules one-off or repeating reminders, and tracks ongoing responsibilities with its own tools. It hands substantial work to worker sessions and relays their reports. A worker in a git repository gets its own worktree under `~/.opendot/worktrees/` and commits on its own `dot/<name>-<id>` branch. Worktrees aren't removed automatically. With several dots, each sees the others' purposes and can message them; a dot sends at most 10 messages an hour. It acts without asking, except before destructive shell commands.

Keep `bun src/cli.ts daemon` running. It delivers due reminders, starts and watches workers, and brings their reports back into the dot's conversation. It also collects your feed: unread GitHub and Linear review requests, mentions and assignments, GitHub activity on threads you opened or commented on, and Slack mentions and DMs, from the last 24 hours, which a dot can read with `dot_feed`.

The feed uses your `gh` login, so the daemon needs `gh` on its `PATH`. For Linear, create a personal API key under Settings → Security & access, then save it in the Keychain, where the daemon finds it within a minute:

```sh
security add-generic-password -a "$USER" -s open-dot-linear -w
```

On macOS, a launch agent starts the daemon at login and restarts it if it exits. Save this as `~/Library/LaunchAgents/com.opzero1.open-dot.daemon.plist`, with your own paths:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.opzero1.open-dot.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/bun</string>
    <string>/path/to/open-dot/src/cli.ts</string>
    <string>daemon</string>
  </array>
  <key>WorkingDirectory</key><string>/path/to/open-dot</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/path/to/gh/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/you/.opendot/daemon.log</string>
  <key>StandardErrorPath</key><string>/Users/you/.opendot/daemon.log</string>
</dict>
</plist>
```

Load it with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.opzero1.open-dot.daemon.plist`. The daemon keeps running the code it started with, so after pulling changes restart it with `launchctl kickstart -k gui/$(id -u)/com.opzero1.open-dot.daemon`.

## Talk from Slack

DM the open-dot Slack app and a dot answers there, under its own name. Start a message with a dot's name, as in `jotaro: what's on today?`, `jotaro, …` or `@jotaro …`, to pick that dot. Without a name, the message goes to the dot you last messaged from Slack, or else your first dot. Only your own messages count: the app ignores anyone else who DMs it. The daemon checks for new messages every 3 seconds, and posts a dot's reply when its turn ends. The conversation also shows in the notch.

Slack mentions of you and DMs to you join the feed, as data for your dots, never as instructions. A DM leaves the feed once you read it in Slack. Slack has no read state for a mention in a channel, so one stays until you dismiss it in the notch or it's a day old. Dismissing changes nothing in Slack.

Limits: a dot replies in Slack only to messages you sent from Slack, so its reminders and follow-ups stay in the notch. Thread replies in the app's DM are ignored; write top-level messages. Messages sent while the daemon is stopped are read when it starts, except that before your first Slack message reaches a dot, the daemon ignores anything older than its start.

### Set it up

The app polls Slack's Web API, so it needs no public URL, events or Socket Mode. Create it at [api.slack.com/apps](https://api.slack.com/apps) with **Create New App → From an app manifest**, pick your workspace, and paste:

```yaml
display_information:
  name: open-dot
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: open-dot
    always_online: false
oauth_config:
  scopes:
    bot: [chat:write, chat:write.customize, im:history, im:read, im:write, metadata.message:read]
    user: [search:read, im:read, mpim:read, channels:read, groups:read]
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

If your workspace requires approval, ask an admin to approve this internal app with these scopes. The bot scopes let it read and write only its own DMs with you, post replies under a dot's name, and tag replies so a lost post can be found. The user scopes let it search messages you can see and read DM read state on your behalf; it never posts or marks anything as you. Install it yourself, so the user token is yours. Then copy the **Bot User OAuth Token** (`xoxb-…`) and the **User OAuth Token** (`xoxp-…`) from **OAuth & Permissions** into the Keychain:

```sh
security add-generic-password -a "$USER" -s open-dot-slack-bot -w
security add-generic-password -a "$USER" -s open-dot-slack-user -w
```

Restart the daemon. Until the tokens it needs are saved, it skips that part and checks the Keychain again once a minute: chat needs both tokens, the feed only the user token.

## Talk from the notch

The notch app is a small native macOS app (macOS 14 or later) that talks to the running daemon. Build and start it:

```sh
cd mac && swift build -c release && .build/release/open-dot-notch
```

Hover over the notch to open the panel: pick a dot, read its conversation, see its unfinished workers, and type to it. Enter sends. The panel closes shortly after the mouse leaves, and keeps your draft. The Feed tab lists what needs you from GitHub, Linear and Slack, newest at the bottom. Click an item to open it, or × to dismiss it, which also marks a GitHub or Linear item read there. A dot beside the notch shows that a dot is busy or that a dot or the feed has something new. Right-click the open panel to quit.

To start the app at login, save a second launch agent as `~/Library/LaunchAgents/com.opzero1.open-dot.notch.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.opzero1.open-dot.notch</string>
  <key>ProgramArguments</key>
  <array><string>/path/to/open-dot/mac/.build/release/open-dot-notch</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Interactive</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>StandardOutPath</key><string>/Users/you/.opendot/notch.log</string>
  <key>StandardErrorPath</key><string>/Users/you/.opendot/notch.log</string>
</dict>
</plist>
```

Load it the same way. It restarts the app if it crashes, but not after you quit it. After rebuilding, restart it with `launchctl kickstart -k gui/$(id -u)/com.opzero1.open-dot.notch`.

open-dot keeps its data in `~/.opendot`. Set `OPEN_DOT_HOME` to use another directory.
