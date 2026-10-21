# open-dot plan

## What it is

A durable personal agent, called a dot, built on OpenCode V2. Instead of a stream of disposable chats, you keep one continuing relationship. You give a dot a name and a purpose, reopen its conversation from anywhere, and it follows up on its own time. It remembers what you told it to keep and delegates substantial work instead of disappearing into it.

OpenCode provides the model, tools, permissions, chat and history. open-dot adds three things: identity, continuity and timing.

This project is a fresh, small rebuild of [open-bot](https://github.com/affddn/open-bot). It keeps the product direction from open-bot's issues and the OpenCode integration lessons, and drops the rest.

## Principles

- **Reuse OpenCode.** Don't add a second chat UI, agent loop, permission system or config language. Use only `@opencode/client` and `@opencode/plugin`, and never read or write OpenCode's database.
- **Attach, don't manage.** Connect with `Service.discover()`. Never start, stop or replace the user's service. Never call `location.reload()`, because it cancels work in other sessions.
- **Persist intent before acting.** Assign each `ses_` and `msg_` ID before the call that uses it. When an outcome is lost, reconcile it by that ID; never blindly send it again.
- **Report reality.** An admitted prompt has not completed, and an idle session has not succeeded. A state of _unknown_ is a real state, not an error to hide.
- **Treat outside content as data.** Connector messages and replies from other dots never carry authority.
- **Stay small.** Use one SQLite database, a handful of source files and a few focused tests.

## Architecture

```
~/.opendot/                              OPEN_DOT_HOME
  open-dot.db                            SQLite (Drizzle): dots, notes, reminders, responsibilities, workers, outbox, feed, slack
  api.json                               the daemon's local API address and token, readable only by the owner
  dots/<name>/AGENTS.md                  the dot's personality and purpose (plain OpenCode instructions)
  work/<name>/                           the default directory for a dot's workers
  worktrees/<name>/<id>/                 the git worktree of a worker that runs in a repository
```

One `plugins` entry in the OpenCode config loads both plugins. The server plugin stays inert outside a dot's directory.

| Part          | Runs in              | Job                                                                                                                                    |
| ------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| CLI           | `open-dot …`         | Create, list and open dots, and run the daemon.                                                                                        |
| Server plugin | OpenCode service     | Provides the tools a dot calls, such as `dot_remind`, `dot_track`, `dot_delegate` and `dot_message`. It writes only to open-dot's DB.  |
| Daemon        | `open-dot daemon`    | The single owner of timers, workers and the feed. It starts worker sessions, watches them, and sends every message through the outbox. |
| TUI plugin    | OpenCode terminal UI | Shows each dot and its recent workers in the sidebar and provides `/dot` and palette commands. It reads the DB read-only.              |
| Notch app     | `mac/`, a macOS app  | Sits at the notch. Hover to pick a dot, read and type to it, and see its workers. It talks only to the daemon's local API.             |

The daemon, not the plugin, owns timers for two reasons. A plugin runs only while its location is loaded, while the daemon can wake a dot whenever the OpenCode service is up. The daemon is also the host for the notch app and connectors, which is how you'll talk to a dot from anywhere.

The daemon serves a small HTTP API on `127.0.0.1` for the notch app, on a new port each start. It writes the address and a fresh random token to `api.json` with mode 0600, and rejects any request without that token, so other local users and web pages can't call it. `GET /dots` lists the dots, whether each is running a turn, and its unfinished workers. `GET /dots/<name>/messages` returns the last 50 messages of the dot's conversation, each labeled as the owner's, the dot's, another dot's, or a notice such as a reminder or worker report. The label comes from the outbox row with the message's ID. A dot's messages show what it said and the open-dot tools it called, not mechanics such as shell commands, file reads or compaction. `POST /dots/<name>/messages` queues the owner's text in the outbox, marked as the owner's, and returns its ID with 202; the app never retries it on its own. While OpenCode is down, every request except the feed's gets 503.

The daemon also collects the feed: once a minute it asks GitHub and Linear for the owner's unread review requests, mentions and assignments, plus GitHub activity on threads the owner opened or commented on, and Slack for mentions of the owner and DMs to them, from the last 24 hours, which costs no model tokens. GitHub uses the token of the `gh` login and Linear a personal API key from the Keychain item `open-dot-linear`; both stay in memory. A notification read at its source leaves the feed at the next pass. `GET /feed` lists the unread items, oldest first. `POST /feed/<id>/dismiss` hides one at once, and the daemon marks it read at its source on its next pass; new activity brings it back, as it does on GitHub. A dot reads the feed with `dot_feed`, framed as data from GitHub, Linear and Slack.

The owner talks to dots in Slack through a DM with an internal Slack app, which the daemon polls every 3 seconds over the Web API: no public URL, events or Socket Mode. Its bot token and the owner's user token live in the Keychain items `open-dot-slack-bot` and `open-dot-slack-user` and stay in memory; the owner is the user token's `auth.test` user. Only the owner's own top-level messages count. Each one is saved in the `slack` table, keyed by its Slack `ts` so a re-poll adds nothing, in the same transaction as its outbox row, marked as the owner's. A leading dot name picks the dot; otherwise it goes to the dot last messaged from Slack. When the turn after it ends, the daemon saves the reply and a fresh reply ID, then posts it with `chat.postMessage` to the DM the message came from, under the dot's name, tagged with that ID in the message metadata. The reply turns _unknown_ just before the post, so a crash or a lost answer leads to a lookup by reply ID in that DM's history, never a blind repost. After a 429 the daemon makes no Slack call until `Retry-After` has passed. Only replies to Slack messages go to Slack. For the feed, the user token's `search.messages` finds mentions and DMs, filtered again locally, and a DM is dropped once `conversations.info` shows it read. Dismissing a Slack item changes nothing in Slack.

Every message the daemon sends goes through the `outbox` table. A producer, such as a due reminder or a finished worker, inserts the message with a fresh `msg_` ID in the same transaction as its own state change. Delivery then checks for that ID before sending, so a lost outcome is confirmed rather than repeated.

A worker is a top-level OpenCode session, because a child session cannot have its own directory. `dot_delegate` saves the worker and its `ses_` ID. The daemon creates the session, queues the task, tells the dot once about each pending approval, and queues one report when the first turn after the task goes idle.

A worker given a directory inside a git repository gets its own worktree, so workers never share a checkout. `dot_delegate` records the repository and a new branch, `dot/<name>-<id>`, in the same transaction that saves the worker. Before creating the session, the daemon adds the worktree from the repository's current HEAD. If git can't add it, the worker ends as failed and the dot gets one report. Worktrees are kept after the worker finishes, so its branch can be reviewed or merged; remove them with `git worktree remove`.

Dots message each other with `dot_message`. Each dot's memory lists the other dots and the purpose each was created with. The plugin inserts the message straight into the outbox, addressed to the other dot's session and recorded with the sender, and the daemon delivers it like any other message. The message is framed as data from another dot, not instructions from the owner, and asks for no reply that only acknowledges or thanks. To stop two dots from keeping each other busy, a dot can send at most 10 messages per rolling hour, counted from the outbox.

Dot and worker sessions are created with `ask` rules for destructive shell commands, such as `rm`, force pushes and hard resets. Everything else follows the owner's OpenCode permissions, which allow all by default. The list is best effort: a pattern list can't catch every destructive command.

The TUI plugin imports no backend code: no `@opencode/client` and no Drizzle. open-bot found that these imports break plugin loading.

## Verified OpenCode behavior

These were checked live against OpenCode 2.1.1 and shape the code:

- **A repeated prompt ID is deduplicated.** Calling `session.prompt` twice with the same `msg_` ID returns that ID both times and leaves one message in history. The daemon's resend-if-absent step relies on this, but still checks by ID first because a concurrent race was not tested.
- **Per-request context goes near the tail.** Memory pushed onto `system` in the `context` hook was fresh in every request, yet the dot kept answering from its first turn's memory. Like OpenCode's own Plan reminders, memory is now a user message placed just before the latest prompt. That also keeps the cached prompt prefix stable.
- **Session permissions come after the agent's.** Rules passed to `session.create` are merged after the agent's rules, and the last match wins. Saved "always allow" approvals come after both.
- **A finished turn ends in an `idle` item.** `session.context` lists it with an outcome of `succeeded`, `failed` or `interrupted`. Message IDs don't sort in processing order, and `session.context` starts at the latest compaction. To find a prompt's turn, the daemon therefore walks `message.list` forward (`order: "asc"`, then each page's `next` cursor) and takes the first `idle` after the prompt. `session.active` lists only running sessions, and `permission.list` lists a session's pending requests.
- **TUI imports need explicit extensions.** OpenCode maps `@opentui/solid` and `solid-js` to its own copies only in local files it can resolve without adding an extension. The root `tui.ts` therefore imports `./src/tui.ts`. Without the extension, the sidebar loads a second Solid and crashes with "No renderer found".

## Milestones

Each milestone is a shippable vertical slice, tracked as a GitHub issue. Verify each one once, when it's complete.

1. **A dot you can open.** Build the scaffold, the DB, `open-dot create|list|open`, and a durable session binding: create the session once with a pre-assigned ID, then reconcile it by ID. Add the TUI sidebar, `/dot` and palette entries. Reopening a dot keeps its history, and a missing binding produces a clear error, not a replacement session.
2. **It follows up.** Add the `dot_remind` and `dot_note` tools and the daemon. Due reminders are queued into the dot's session with deterministic `msg_` IDs. Reminders survive a restart, and an unknown delivery is reconciled by ID, never duplicated.
3. **It delegates.** Add responsibilities, each with a goal, a next action and a status. The dot hands substantial work to worker sessions, tracks them, and brings a linked summary back into its conversation. It also gets a simple recurring schedule.
4. **Dots talk to each other.** Several specialist dots can message each other, and replies are treated as untrusted data.
5. **Talk to it from the notch.** The daemon serves a small local API, and a thin native macOS app talks to it. Hovering over the notch opens a panel where you pick a dot, read its conversation, type to it, and see worker results arrive.
6. **A feed in the notch.** The daemon collects what needs your attention from GitHub and Linear, such as review requests, mentions and assigned issues, and the notch shows it as a live, Twitch-style stream you can act on. Feed items reach a dot only as data.
7. **Slack.** DM an internal Slack app to talk to a dot, and it replies there under its own name. Only the owner's messages instruct a dot there. Your Slack mentions and DMs join the notch feed as untrusted data.

## Deferred or dropped

- **Deferred:** supervising existing sessions, rich goal and planning views, voice, native mobile and remote executors.
- **Dropped:** open-bot's governance control plane, coordinator ownership epochs, workflow VM, duplicate chat UIs, Python fixtures and vendored lint plugins.

## Decisions

- **The client is a thin native macOS app in the notch,** not a web client. It holds no state of its own and talks only to the daemon. It comes before Slack.
- **The first notch version shows the notification feed as well as dot chat.** The feed shows things that need your attention, not every event.
- **Slack does two jobs:** it's a way to talk to your dots, and a source the dots watch for you.
- **Dots run only on this Mac for now.** An always-on host can come later.
- **A dot may do anything except destructive actions without asking,** like Grok Bot, Codex or pi-durable. Destructive actions, such as deleting files, force pushes or hard resets, still ask the owner.

## Work queue

GitHub issues in `opzero1/open-dot` are the queue. Each open issue carries exactly one `status:ready`, `status:in-progress` or `status:blocked` label, and closing an issue means it's done. A blocked issue says what would unblock it. This file holds the plan, not task state.
