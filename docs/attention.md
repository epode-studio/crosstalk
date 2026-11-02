# Sessions and attention

What crosstalk does about sessions themselves: which thread an unsure one is
in, when to start one fresh, when a thread needs another agent, which session
the person is looking at, and how a question that someone is blocked on gets
in front of them. The code is `src/attention/`; the design is
`docs/design/next-generation.md` ("Questions", "Getting someone on it", "The
terminal", "Wrangling every session").

Every question here is a crosstalk question (a picker from the mod in the
session the person is in, hidden from that session's agent). Without the mod
it is a systemMessage line, answered in plain words through
`crosstalk_answer action "attention"`.

## Recaps

When a session's files touch two threads equally, or only files no thread
covers, its own last turns decide: the last prompt the person typed and the
last thing the agent said, read from the tail of the transcript (no model
call). The words they share with each candidate thread's recap, name,
features, tasks, decisions and questions break the tie: one more shared word
than the next candidate when the files already narrowed it down, three when
the alternative is starting a new thread. It runs whenever the daemon places
the session, and again at Stop while placement is still unsure. A thread with
no recap takes the session's.

`CROSSTALK_RECAP_MODEL=haiku` summarises the two turns in one sentence with
`claude -p --model haiku` instead, in the background; the extract is used
until the sentence arrives.

## Disposable sessions

When a session's context is nearly spent (85% by default,
`CROSSTALK_DISPOSE_PCT`), crosstalk asks: "api's context is 91% spent. Start a
fresh session from auth instead of compacting?" The reading comes from the
mod (`$.session.usage().context`, the status line's `context_window`
figures) after each turn, or from the transcript's last assistant usage at
Stop. An automatic `PreCompact` asks the same. A `/compact` the person typed
is left alone.

Answering "Start fresh" twice offers the standing rule ("Always start
fresh"); with the rule, a PreCompact is blocked and the session restarts at
once. The rule is the person's own, kept in this machine's attention state
like the disk rule: a rule in the repository's shared RULES.md never ends
anyone's sessions. The `attn_dispose_rule {on: false}` op turns it off.

Starting fresh: the session's restore record is marked ended, reason
`disposed` (restore and gather never take it for a crash); the thread is
written out as a primer (recap, decisions, open questions, tasks, facts,
files, framed as data); the old claude is ended the way gather ends one
(SIGTERM, then SIGINT twice, pid verified, never SIGKILL); and
`claude "$(cat <primer>)"` starts in the same tab: typed into its shell, or,
when claude was the tmux pane's own command (crosstalk's background agents),
respawned in the same pane with `remain-on-exit` holding it open. The next
session to register in that folder is put in the same threads. Where the tab
cannot be typed into, nothing is ended.

While something the session started still runs (a dev server from a
backgrounded Bash call, a watcher), nothing is ended: the fresh start waits,
silently, and if the context fills up meanwhile Claude Code compacts as usual
([services.md](services.md)).

## Staffing

A thread with a session active in it is stuck when a blocking question has
gone unanswered for two hours, or nothing moved for two hours (no file edited
by its sessions, no commit on their checkouts; `CROSSTALK_STUCK_MS`). One
question per stuck spell: "auth has been stuck for 2 hours. Add a second
agent?" Yes starts one through `src/spawn.ts`, in the background, with the
thread's brief as its first prompt. No budgets.

## Focus

Which session the person is looking at, asked of each terminal the live
sessions are in:

| Terminal | How |
|---|---|
| tmux | `list-clients -F '#{client_flags} #{client_activity} #{pane_id}'`: the client flagged `focused` (tmux 3.3+, focus-events on), else the most recently active |
| Terminal.app | AppleScript: `tty of selected tab of front window`, only when Terminal is frontmost |
| iTerm2 | AppleScript: `tty of current session of current window`, only when frontmost |
| kitty | `kitten @ ls`: the focused window of the focused tab of the focused OS window |
| WezTerm | `wezterm cli list-clients --format json`: the least idle client's `focused_pane_id` |
| anything else | the session typed in last (the UserPromptSubmit hook touches `<home>/typed/<session>`) |

A question for "the session you are in" goes to the main session when there
is one, else the one in front, else the one typed in last, never a background
agent. The route question ("which session gets ben's message?") uses the same
order. The daemon polls every 15 s (`CROSSTALK_ATTENTION_TICK_MS`) to notice
focus changes.

Focusing a tab (only on the person's word or a click): tmux `switch-client` +
`select-window` + `select-pane`; Terminal.app and iTerm2 by AppleScript
(select the tab, raise the window, activate); kitty `kitten @ focus-window
--match id:N`; WezTerm `wezterm cli activate-pane --pane-id N`.
`crosstalk_work action "show"` ("show me api") does this for a session that is not a
background agent, and `crosstalk attn focus --session <id>` is what a
notification's click runs.

## Notifications

A blocking question (a thread question marked blocking, or a background
agent's permission request) while the person is not looking at the asker:

- kitty: OSC 99 written to the asker's own tty; kitty focuses that window on click
- macOS with `terminal-notifier`: `-execute "crosstalk attn focus --session …"`, so the click focuses the tab
- macOS without it: `display notification` (no jump); Linux: `notify-send` (no jump)
- always: a receipt in the session the person is in, "api (auth) is waiting on you. Say "show me api" to go to it."

`CROSSTALK_NO_NOTIFY=1` turns the desktop part off.

## The phone

Away means nothing typed in any session and no change of the tab in front
for 10 minutes (`CROSSTALK_AWAY_MIN`). A blocking question while away is
pushed:

- **ntfy**: a POST to the configured topic, body only `crosstalk: 1 question
  waiting in <thread>`, never the question, repo or people. Configure in
  `<crosstalk home>/attention.json` as `{ "ntfy": { "url": "https://ntfy.sh",
  "topic": "<long random>", "token": "<optional>" } }`, or
  `CROSSTALK_NTFY_URL=https://ntfy.sh/<topic>` (+ `CROSSTALK_NTFY_TOKEN`).
- **Claude's own push**: Claude Code 2.1.316 has no hook event or setting a
  plugin can push through, but it lists a built-in `PushNotification` tool
  (`{ message, status: "proactive" }`, result `pushSent` / `disabledReason:
  config_off | user_present | no_transport`), sent to the Claude app through
  Remote Control. The mod calls it with the same sealed line through
  `$.tool.call`, only when `$.tool.list()` shows the tool. Untested end to end
  (it needs a phone paired through Remote Control).

## Background agents' permission prompts

A session crosstalk starts in the background (`tmux -L crosstalk`, or
`claude --bg`) carries `CROSSTALK_BG_AGENT=<name>`. crosstalk's own
`PermissionRequest` hook (hooks/hooks.json, timeout 3600 s) sees it and asks
the daemon (`attn_permission`), which puts "auth-2 (in the background) wants
to use Bash: npm test. Allow it?" with Allow / Allow for this session / Deny
to the person, and holds the request open (55 minutes,
`CROSSTALK_PERMISSION_WAIT_MS`). The answer goes back to the waiting hook as
`hookSpecificOutput.decision`: `{ behavior: "allow" }`, `{ behavior:
"allow", updatedPermissions: <the request's permission_suggestions> }` or
`{ behavior: "deny", message }`. No answer in time prints nothing, so Claude
Code's own dialog stays up for "show me auth-2". Sessions the person runs
themselves are never relayed.

Why the hook and not the channels relay: the channels permission relay
(`permission_request { request_id, tool_name, description, input_preview }`
answered with `{ request_id, behavior }`) needs the session started with a
development-channels flag and a channel server; the hook needs nothing on the
command line and, on 2.1.316, Claude Code waits for it (the hook's own
timeout decides). Checked against the real binary: test/attention-real.sh.

## Without tmux

Where tmux is missing (native Windows, mostly), a background agent is Claude
Code's own background session: `claude --bg -n <name> "<task>"` in its
worktree, detected from `claude --help` (`--bg`, and an `attach` command;
both on 2.1.316). "show me <name>" opens a tab running `claude attach <name>`.
Without `--bg` either, a background agent is refused as before.
`CROSSTALK_CLAUDE_BG=0/1` overrides the detection.

## OSC 7501

The Program Status Protocol is emitted only behind `CROSSTALK_OSC7501=1`,
and only for terminals known to read it (Ghostty 1.4+, Rex, by
`TERM_PROGRAM`), never inside tmux: the tab-status applier also writes
`ESC ] 7501 ; state=<working|blocked:kind=question|done|idle>:app=crosstalk
ESC \` to the session's tty. crosstalk never sends the `7501;?` query.

## What is not tested on a Mac

The unit tests drive every adapter with a fake terminal, and test/attention.sh
runs on Linux with real tmux. Untested for real: Terminal.app and iTerm2
focus queries and focusing by AppleScript (Automation permission),
`terminal-notifier -execute`, kitty OSC 99 click-to-focus, kitty and WezTerm
remote control, the PushNotification tool, and `claude --bg` / `claude attach`.
