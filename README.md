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

Limits: a dot replies in Slack only to messages you sent from Slack, so its reminders and follow-ups stay in the notch. Messages you send while a dot is still answering are folded into its current turn, so it gives one reply, to the last of them. Thread replies in the app's DM are ignored; write top-level messages. Messages sent while the daemon is stopped are read when it starts, except that before your first Slack message reaches a dot, the daemon ignores anything older than its start.

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
    user: [search:read, im:read, mpim:read, channels:read, groups:read, users:read]
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

If your workspace requires approval, ask an admin to approve this internal app with these scopes. The bot scopes let it read and write only its own DMs with you, post replies under a dot's name, and tag replies so a lost post can be found. The user scopes let it search messages you can see, read DM read state and look up the names of people a message mentions, on your behalf; it never posts or marks anything as you. Once an admin approves it, install it yourself: the user token belongs to whoever installs the app, and whoever that is can instruct your dots. The daemon logs `Slack: acting for <name> (<user ID>)` so you can check. Then copy the **Bot User OAuth Token** (`xoxb-…`) and the **User OAuth Token** (`xoxp-…`) from **OAuth & Permissions** into the Keychain:

```sh
security add-generic-password -a "$USER" -s open-dot-slack-bot -w
security add-generic-password -a "$USER" -s open-dot-slack-user -w
```

The daemon picks them up within a minute, without a restart. Until the tokens it needs are saved, it skips that part and checks the Keychain again once a minute: chat needs both tokens, the feed only the user token. If Slack rejects a token or says it lacks a scope, or `open-dot-slack-bot` holds a token that isn't a bot's, the daemon logs it, drops the token and reads the Keychain again a minute later. Feed titles show mentions of you by your Slack handle, and mentions of others by name, which needs `users:read`. An app installed before that scope was added still works: the daemon sees from Slack's `x-oauth-scopes` header that the scope is missing, never asks for names, shows others by user ID and logs once what to do. Add `users:read`, reinstall the app, and save its new User OAuth Token under `open-dot-slack-user`. If the previous token remains valid, restart the open-dot daemon to load its replacement; valid tokens stay cached. If Slack sends no scopes header, the daemon tries a lookup, and its `missing_scope` drops the token and pauses Slack until the Keychain is read again a minute later.

### Give a dot its own Slack app

A dot can have its own Slack app, with its own name, profile and agent view, and an @handle that works in any channel you invite it to. The shared open-dot app stays: the feed and its DM work as before.

1. Generate an app configuration token pair at [api.slack.com/apps](https://api.slack.com/apps), under **Your App Configuration Tokens → Generate Token**, for your workspace. Save it with `bun src/cli.ts slack config`, which asks for the access token (`xoxe.xoxp-…`) and the refresh token (`xoxe-…`) without echoing them and keeps both in the one Keychain item `open-dot-slack-config`. A configuration token lasts 12 hours, so the daemon rotates the pair with `tooling.tokens.rotate` before each use and saves the new pair in the same item. Slack's answer to the rotation must name you and your workspace, as `open-dot-slack-user` does, or no app is created.
2. Run `bun src/cli.ts slack connect jotaro`, or answer yes when `open-dot create` asks in a terminal. This only records the request. The daemon creates the app named after the dot with `apps.manifest.create` within about 10 seconds. It keeps only the app's ID, never its client or signing secrets.
3. Run `bun src/cli.ts slack status jotaro` and follow its steps. Slack only sends an install's OAuth code to an HTTPS address, which the daemon doesn't have, so you install the app and copy its tokens yourself:
   - Open the app's **Install App** page and click **Install**, then **Allow**. If your workspace needs an admin to approve apps, ask for that first.
   - Optionally set its icon under **Display Information**. Slack's manifest has no field for it.
   - Under **App-Level Tokens** on the **Basic Information** page, generate a token with the `connections:write` scope.
   - Save the **Bot User OAuth Token** (`xoxb-…`) and the app-level token (`xapp-…`). Each command asks for the token without echoing it:

     ```sh
     security add-generic-password -U -a "$USER" -s open-dot-slack-jotaro-bot -w
     security add-generic-password -U -a "$USER" -s open-dot-slack-jotaro-app -w
     ```

4. Within a minute the daemon checks the tokens and connects over Socket Mode. `slack status` then says `active`. Invite the dot to a channel with `/invite @jotaro`.

What it does:

- When you mention the dot in a channel, it replies once in that message's thread when its turn ends. Each mention gets its own reply, even if the dot answered several in one turn. The dot is given every message in the thread it hasn't seen yet, all of it the first time, as data framed in a `<slack-thread>` block; only your mention instructs it. If the thread can't be read in full, the mention waits and is tried again.
- A DM to the dot's app, including its agent view threads, goes to that dot, with no name needed. The reply goes back to the same DM or thread.
- A worker's report goes to your DM with the dot's app, as well as the notch, never to a channel thread. Mention the dot again to have it post a result there. Only reports from after the app connected are sent.
- When someone else mentions or DMs a dot, nothing reaches the dot. They get one note only they can see, such as "jotaro only answers @Afif.", once per conversation.
- The shared open-dot app can do the same for anyone who DMs it, but only once you turn it on with `bun src/cli.ts slack notices enable`. Until then it doesn't read its DMs for this or send any note. Once on, it checks once a minute and answers DMs sent from the moment you turned it on, including ones sent while the daemon was stopped, never older ones. Running `enable` again keeps that moment. `bun src/cli.ts slack notices disable` turns it off, and `bun src/cli.ts slack status` says which it is.

How it stays safe:

- An app is created only after you ask. The attempt is saved before the call. If Slack's answer is lost, the dot's app turns `unknown` and is never created again on its own: look for it at api.slack.com/apps and run `bun src/cli.ts slack attach jotaro <app ID>`, which has the daemon check that the app's bot is named after the dot and uses Socket Mode, or, if there's none, run `bun src/cli.ts slack connect jotaro --retry`. A late answer about an app you named earlier never changes one you've named since.
- A rotation is saved as started before the call. If its answer is lost or its new pair can't be saved, every later rotation stops, because Slack may already have used up the old refresh token. Generate a new pair and save it with `slack config`.
- A bot token is used only once `auth.test` shows a bot in your workspace and `bots.info` shows it belongs to the dot's app, and, once connected, the same bot and bot user as before, even for a token read again without a restart. A connection's `hello` never replaces the bot an app saved. Slack's `hello` must name the dot's app, and each event must name that app and workspace. A token saved in the wrong item is dropped and the Keychain read again a minute later.
- Each event is saved before Slack gets its acknowledgement, with only the fields open-dot needs and never the envelope's verification token. Slack sending it again, under the same or a new event ID, adds nothing. Only your own messages are kept with their words.
- A reply's ID is saved before it's posted, and the reply turns _unknown_ just before the post. An unknown reply is only looked up by that ID among the dot's own posts in that conversation, once a minute for an hour, and never posted again; if it's never found it stays unknown. Slack refusing a post marks it failed.
- A token check that fails, such as Slack answering `internal_error` to the bot token's `auth.test`, means the call it guarded was never sent, so a reply waiting on it is posted later rather than marked unknown or failed.
- If `slack config` can't turn off the terminal's echo, and show that it's off, it stops before asking for a token, and puts the terminal's settings back.
- A note to someone else is saved before it's sent and never sent twice, even if its answer was lost, so a note can go missing but never repeat.

The app's manifest asks for these bot scopes: `app_mentions:read`, `assistant:write`, `channels:history`, `chat:write`, `groups:history`, `im:history`, `im:read`, `im:write`, `metadata.message:read` and `users:read`, which `bots.info` needs. It subscribes to `app_mention` and `message.im` over Socket Mode. Not yet checked live: whether Slack shows the AGENT badge, and whether your workspace lets you install your own apps.

## Talk from the notch

The notch app is a small native macOS app (macOS 14 or later) that talks to the running daemon. Build and start it:

```sh
cd mac && swift build -c release && .build/release/open-dot-notch
```

Hover over the notch to open the panel: pick a dot, read its conversation, see its unfinished workers, and type to it. Images attached to a message, such as a screenshot pasted into OpenCode, show as thumbnails; click one to open it full size in its own window. Other attachments show their file name. Enter sends, and Shift-Enter or Option-Enter starts a new line. The message box has the standard editing shortcuts: ⌘A, ⌘X, ⌘C, ⌘V, ⌘Z and ⇧⌘Z, with each draft's undo kept to itself. The panel closes shortly after the mouse leaves, and keeps your draft. The Feed tab lists what needs you from GitHub, Linear and Slack, newest at the bottom. Click an item to open it, or × to dismiss it, which also marks a GitHub or Linear item read there. Hover an item and click **Reply** to send it to one or more dots: pick the dots (the one you last chatted with is picked), then write a prompt, or start from **Start on it** or **Use as context**, which only fill the box for you to edit. Each dot gets its own message with your prompt and the item, as data, and the notch opens the first dot's chat. The item moves to a collapsed **Handed off** list that names the dots it went to, where you can reply again to send it to more. A send that fails or gets no answer shows in that dot's chat and under the item, with your prompt kept, and is never sent again on its own. A dot beside the notch shows that a dot is busy or that a dot or the feed has something new. Right-click the open panel to quit.

Hover a dot's chat bubble to pick ❤️, 👍, 👎, 😂, ‼️ or ❓. Clicking your selected emoji removes it; choosing another replaces it. A corner badge shows the saved reaction and survives reopening the app. The dot can explicitly use `dot_react` to react to one of your messages, with its badge on your bubble. Notices, peer messages and pending messages have no reactions. Reactions stay local to the notch: they do not mirror to Slack or start a turn. Your dot sees current feedback, including removals, on its next normal model request. While a change is saving the picker is disabled; an unconfirmed change shows an error and is never retried automatically.

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
