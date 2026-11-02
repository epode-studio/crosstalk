# Restore after a restart

When your computer restarts unexpectedly, or your terminal crashes or is force-quit, the first
Claude Code session you open afterwards says:

```
◢ crosstalk: 6 sessions were open before the restart (api, firmware, docs, web, …). Say "restore them" to bring them back.
```

With crosstalk's mod running (an interactive Claude Code that loads mods), the same question
is Claude Code's own picker instead, as soon as your prompt is empty and nothing is running:

```
 ☐ Restore
Restore 3 sessions from before the restart? (firmware, docs, web)
❯ 1. Restore
  2. Open as windows
  3. Not now
```

Exactly one of the two shows: the mod tells the hook it is there before the hook runs. "Not
now" forgets nothing, and Esc puts it off until your next turn has ended. It never pops up by
itself again after a `--resume`.

**Just say "restore them".** Each session comes back in its own tab of your terminal, in the
same order, in its folder, as `claude --resume <id>`. The conversation comes back with it, so
you don't need to paste anything.

You don't have to remember anything. The question only appears in your session, and the
model never sees it. If you'd rather not restore them, ignore the question. After a day, the sessions are no longer offered.

## What it does

- **It remembers every open session**: its id, folder, client (Claude Code or Codex), process,
  and terminal tab. Each session has a small file under `~/.claude/crosstalk/open/`, which the
  crosstalk hook writes. You don't need a room or the daemon for this.
- **A session that ends normally says so.** When you leave at the prompt, `/clear` or log out,
  the `SessionEnd` hook records that the session ended, and it won't be offered again.
- **A session whose process is gone without that was lost.** That covers two cases. One is a
  restart: the session was last seen before the machine booted. The other is a terminal that
  died under it: the process is gone and there was no normal end, even within the same boot. Several sessions that
  end in the same few seconds also count, because they went down with their terminal. Closing a
  single tab doesn't count. Only sessions seen within the last 24 hours count.
- **The first session opened afterwards asks once.** Later sessions don't ask again. The
  sessions stay restorable from any session until you answer.
- **The session that asks is never reopened**, because it is already open.

### Which terminal it uses

Each session goes back to the terminal it was in. If that terminal can't be used now, the
session goes to the terminal you are asking from:

| Terminal | How | Layout |
|---|---|---|
| **Terminal.app** | AppleScript (`do script`), new tabs by Cmd-T through System Events | one window per repository, in the order each was first opened, tabs in their old order; into the window already holding that repository if one is open |
| tmux | `tmux new-window -d -t <session>: -c <folder>`, and the tmux session is recreated if it is gone | windows in their old index order; agents crosstalk ran in the background go back to `tmux -L crosstalk` |
| iTerm2 | AppleScript, `create tab` | one window per repository, tabs in order; into the window already holding it if one is open |
| Ghostty | AppleScript keystrokes (Cmd-N, Cmd-T, typing the command) | tabs in one window |
| kitty | `kitten @ launch --type=tab` (needs `allow_remote_control`) | tabs, beside the repository's open window if any |
| WezTerm | `wezterm cli spawn` | tabs, in the repository's open window if any |
| Windows Terminal | `wt -w 0 nt -d <folder>` | tabs |
| anything else | the exact commands, shown to you and written to `~/.claude/crosstalk/restore-commands.sh` | paste each into a tab |

Every worktree of a repository counts as that repository, so an agent's worktree comes back
beside its main checkout. Existing tabs are never moved; see [the terminal workspace](terminal.md).

Codex sessions come back as `codex resume <id>`. Clients that can't resume a session by id are
skipped, and the result says so.

## Permissions on a Mac

macOS can't open a tab in Terminal.app from a script directly. The only way is to press Cmd-T,
and for that Terminal needs two permissions:

1. **Automation, Terminal → System Events.** This lets crosstalk tell System Events to press
   the key. macOS asks for it once, the first time sessions are restored as tabs. Choose
   **Allow**.
2. **Accessibility, Terminal.** This lets System Events actually type the key. macOS never
   grants it by itself.

The app named here is **Terminal** because that is the app crosstalk runs inside. In iTerm2 or
Ghostty, the permission is for that app instead.

Without either permission, nothing breaks: each session opens in **a window of its own**
instead of as a tab.

### What happens when one is missing

When you ask for a restore and Accessibility is off:

- crosstalk opens **System Settings → Privacy & Security → Accessibility** for you, and says:
  "Opened System Settings. Turn on Terminal under Accessibility; crosstalk will finish
  restoring by itself."
- A small background process checks every 2 seconds whether the permission is on. It only
  reads the setting and never prompts. As soon as the permission is on, it opens the sessions
  as tabs and posts a notification.
- If the permission is not turned on within 2 minutes, nothing opens. A window appearing
  minutes later would be more surprising than useful. You get a notification instead, the
  sessions stay listed, and saying "restore them" again picks up where it left off.
- crosstalk only opens System Settings because you just asked for a restore, never on its
  own, and never twice within 2 minutes. macOS may also show its own prompt with an "Open
  System Settings" button, and either one works.

If Automation was refused, the sessions still open, as separate windows. crosstalk opens
**Privacy & Security → Automation** so that next time they open as tabs. There, under
Terminal, turn on System Events.

To turn the permissions on yourself:

```sh
open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"   # turn on Terminal
open "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"      # Terminal → System Events
```

`/crosstalk:doctor` shows whether both permissions are on, and what is waiting to be
restored. Both checks are read-only: Accessibility through `AXIsProcessTrusted`, Automation
through `AEDeterminePermissionToAutomateTarget` with "ask the user" off.

## Try it without restarting your Mac

**The quick way:** from a clone of this branch, run

```sh
bash scripts/try-restore-mac.sh
```

It opens three test sessions with crosstalk loaded only for them, kills exactly
those three as a crash would, and opens a new session that restores them.
Nothing is installed and your other sessions are not touched. Afterwards,
`bash scripts/try-restore-mac.sh --clean` removes the test folders.

**By hand:**

1. Install crosstalk from this branch:

   ```sh
   git clone -b claude/laughing-goldberg-dw38w3 https://github.com/epode-studio/crosstalk ~/crosstalk-restore
   ```

   Then, in Claude Code:

   ```
   /plugin marketplace add ~/crosstalk-restore
   /plugin install crosstalk@epode
   ```

   (`epode` is the marketplace's name in `.claude-plugin/marketplace.json`.) Restart Claude Code
   so the hooks load.

2. Open two or three Terminal tabs, ideally across two windows, each in a different folder, and
   run `claude` in each. Say anything in each one, so each session has a conversation to come
   back to.
3. **Force-quit Terminal**: press Cmd-Option-Esc, choose Terminal, and click Force Quit.
4. Reopen Terminal. If macOS restores its windows, you can close them. Then `cd` anywhere and
   run `claude`.
5. The question appears. Say **"restore them"**.

The first time, macOS asks whether Terminal may control System Events. Allow it. If
Accessibility is off, System Settings opens. Turn on Terminal, and the tabs open by
themselves.

To see what would happen without opening anything, run this from any terminal:

```sh
~/crosstalk-restore/bin/crosstalk restore --dry-run
```

It prints each command and the exact AppleScript that would run.

## For scripts

```sh
crosstalk restore             # list what was lost
crosstalk restore --dry-run   # and exactly what would run
crosstalk restore --yes       # reopen them (--windows: one window each, no Accessibility)
crosstalk restore no          # forget them
```

In a session, `@restore`, `@restore windows` and `@restore no` do the same before the prompt
reaches the model. They are shortcuts, and you don't need them.

## Sessions started before crosstalk

Sessions that were already running when you installed crosstalk don't have its hooks. crosstalk
still knows about them, because Claude Code lists every running session in
`~/.claude/sessions/`. At most once a minute, whenever a crosstalk hook or the mod runs, each of
those sessions gets a record marked `adopted: "watched"`. The record holds its id, folder, pid
and start time, tty, Terminal.app window and tab (found by tty), and tmux pane. So a crash
restores them too.

The first session you open afterwards asks once:

```
 ☐ Gather
4 Claude sessions started before crosstalk. Bring them in? Idle ones restart in their tab with their conversation.
❯ 1. Bring them in
  2. Not now
```

Without the mod, the same question is a systemMessage. You answer it in plain words ("bring my
other sessions into crosstalk"), which reaches `crosstalk_gather`.

After yes, each session restarts only once Claude Code's registry says it is **idle**. A busy
session waits until it next goes idle. A detached `crosstalk gather --finish` checks every 2
seconds, for up to 2 hours. For each session, crosstalk:

1. checks that the pid is still the same claude process (same start time),
2. sends it SIGTERM and waits for it to exit. If it hasn't exited, SIGINT follows, twice at most,
   and never SIGKILL. A session that still runs after that is left alone,
3. types `cd <folder> && claude --resume <id>` into the same tab, where the shell prompt is back.
   Terminal.app gets `do script … in tab N of window id W`, tmux gets `send-keys`, and iTerm2,
   kitty and WezTerm get their own send-text. Any other terminal, or a claude that wasn't started
   from a shell, reopens in a new tab through the restore adapters, and the receipt says so.

These exits are recorded as intended, so restore never offers them back. The session you're
asking from is never restarted. When everything is done, you see "4 sessions are now in
crosstalk": the mod shows it as a toast, and without the mod it appears on your next prompt.

```sh
crosstalk gather          # list them
crosstalk gather --yes    # bring them in
```

An idle session with something it started still running (a dev server, a
watcher) counts as busy: it is restarted once that has stopped, so nothing it
started dies with it ([services.md](services.md)).

## Limits

- A watched session has no SessionEnd hook. A watched session that is gone and whose registry
  file Claude Code removed (a normal exit) counts as ended. One that is gone with its registry
  file left behind, or one that was open before a restart, counts as lost.
- Reading another process's terminal variables (`TERM_PROGRAM`, `TMUX_PANE`, kitty, WezTerm,
  iTerm2) uses `/proc/<pid>/environ` on Linux and `ps -wwE` on macOS. Where neither can read
  them, the tab is found by its tty alone: tmux panes and Terminal.app tabs (asked only when
  Terminal is already running).
- A session restarted this way comes back as `claude --resume <id>`, without whatever flags it
  was first started with.

- Terminal's window ids are recorded when a session starts and at the end of each turn. A tab
  dragged to another window since its last turn comes back in the old window.
- If macOS reopens Terminal's windows after a restart ("Reopen windows when logging back in"),
  restored sessions open next to those windows, not inside them.
- A restored tab runs `claude --resume` in your shell, so the tab stays open after Claude
  exits. tmux, kitty, WezTerm and Windows Terminal start `claude` directly, so their tab closes
  when Claude exits.
- Codex has no `SessionEnd`, so a Codex session is only offered back after a restart, never
  after its terminal is closed.
