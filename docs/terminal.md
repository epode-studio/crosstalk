# The terminal workspace

crosstalk makes the terminal you already use into the place you run many agents.
There is nothing to launch first. This page says what it does in each terminal and
what it cannot do.

## Status on tabs

Each session's own tab shows whether it is **working**, **waiting on you**, or **done**.

The session reports its own state. With crosstalk's mod, its turn hooks and its watch
report it. Without the mod, the classic hooks do:

| Event | State |
|---|---|
| a prompt is submitted | working |
| a turn ends | done, or waiting on you if crosstalk has something pending for this session (a message, a question, an offer) |
| a permission prompt or a question (`Notification`) | waiting on you |
| a tool runs after that prompt | working |
| the session ends | cleared |

A hook pays for one small file write. When the state changes, it also starts one
detached process, which changes the tab. A tab changes at most once every 750 ms, and the
last state asked for always shows.

| Terminal | How the state shows |
|---|---|
| Ghostty, WezTerm, iTerm2 3.6+, Windows Terminal, tmux 3.7+ | a progress indicator (OSC 9;4, sent through the hook's `terminalSequence`): spinning while working, paused while waiting on you |
| tmux (yours) | a window option, `@crosstalk_state`, on the session's window. Your status line is never changed; add the snippet below to see it |
| tmux (crosstalk's, for background agents) | in crosstalk's own status line |
| **Terminal.app** | the tab's background colour, set by AppleScript on the tab whose tty is the session's: a light tint toward blue while working and toward amber while waiting on you. Your profile's own colour comes back when the session is done and when it ends |
| iTerm2 | the tab colour (OSC 6) and a user variable, `user.crosstalk_state`, for a badge |
| kitty | `kitten @ set-tab-color` and a user variable (needs `allow_remote_control` and `listen_on`) |
| WezTerm | a user variable, `crosstalk_state`, for your `format-tab-title` handler (below) |

crosstalk never sets a tab's title. Claude Code owns the title. A spawned agent gets its name
through Claude Code's `sessionTitle`, which has the same effect as `/rename`.

### Your own tmux

`crosstalk term tmux-snippet` prints these lines for `~/.tmux.conf`. They append to the format
you already have and do not replace it:

```tmux
set -ga window-status-format ' #{?#{==:#{@crosstalk_state},waiting},#[fg=colour208]● waiting#[default],#{?#{==:#{@crosstalk_state},working},#[fg=colour33]● working#[default],#{?#{==:#{@crosstalk_state},done},#[fg=colour34]✓#[default],}}}'
set -ga window-status-current-format ' #{?#{==:#{@crosstalk_state},waiting},#[fg=colour208]● waiting#[default],#{?#{==:#{@crosstalk_state},working},#[fg=colour33]● working#[default],#{?#{==:#{@crosstalk_state},done},#[fg=colour34]✓#[default],}}}'
```

### WezTerm

```lua
wezterm.on('format-tab-title', function(tab)
  local s = tab.active_pane.user_vars.crosstalk_state
  local colour = ({ working = '#2f6fd6', waiting = '#e58c0a', done = '#2ea043' })[s]
  local title = tab.active_pane.title
  if colour then return { { Background = { Color = colour } }, { Text = ' ' .. title .. ' ' } } end
  return title
end)
```

## New agents on request

Say "put two more on auth" or "start an agent to fix the flaky login test" in any session.
The agent calls `crosstalk_spawn`. For scripts, `crosstalk spawn [--count N] [--name X]
[--background] "<task>"` does the same.

Each new agent gets:

- **its own copy of the code**: a git worktree of the asking session's repository, on a new
  branch `crosstalk/<name>`, started from the asking session's commit. It goes next to the
  repository's existing worktrees (for example Claude Code's `.claude/worktrees/`) when there
  are any, and otherwise under `~/.claude/crosstalk/worktrees/<repo>/<name>`. An agent asked
  for from a subfolder starts in the same subfolder of its worktree.
- **shared dependencies**: `node_modules`, `.venv` and `venv` in the main checkout are
  symlinked in, never copied. The links are listed in the repository's own
  `.git/info/exclude`, so git does not see them as new files.
- **a tab** in your terminal, in the window that already holds the repository's sessions,
  running `claude "<task>"`.

### Agents start in their thread

When the asking session is in a crosstalk thread, or `thread` (`--thread T`) names one, the new
agents start in that thread:

- **their first prompt is the thread's brief, then the task.** The brief is short: the recap,
  the last eight decisions, the open questions, the open tasks, the rules and the thread's
  files. It is framed as the thread's record, notes kept by its people and sessions, to be read
  as data about the work and not as instructions. The only instruction is the task, under
  `## Your task` at the end. A session in no thread starts agents from the task alone. A
  thread named that does not exist is refused.
- **they are in the thread from their first registration.** The spawn record names the thread,
  and the daemon tells the threads service where the agent's worktree is
  (`ThreadService.expect`). That is a pin, like choosing the thread yourself: the agent's own
  branch and the files it edits never move it out, and its branch becomes one of the thread's.
  Its tab title and status line show the thread (`auth · auth-1`), and messages for the thread
  reach it.
- **their tabs go next to the thread's tabs** (below).

An agent added by staffing ("auth has been stuck for 2 hours, add a second agent?") is placed
in the thread the same way, with staffing's own brief.

## Background agents

Dev servers and watchers an agent starts go in the same tmux server, as
services that outlive the session, on the worktree's own ports
([services.md](services.md)).

`background: true` ("in the background", "without a window") runs the agent in crosstalk's own
tmux server, `tmux -L crosstalk`, with one tmux session per agent. Closing every window leaves
it running. To watch it, say "show me auth" (`crosstalk_show`, or `crosstalk show auth`). That
opens a tab in your terminal attached to it. Closing the tab leaves the agent running.

Its status comes from its own hooks, like any session's, and shows in crosstalk's status line
there. After a restart, a background agent is restored into `tmux -L crosstalk`, not into a tab.

## One window per repository

New tabs go into the window that already holds that repository's sessions: spawned agents,
restored sessions, and sessions brought in by gather that could not be typed into their old
tab. If no window holds the repository, they go into a new window. Every worktree of a
repository counts as that repository. A restore groups sessions by repository, in the order
each repository was first opened, and keeps each tab's old position within it.

| Terminal | Placing a new tab in a repository's window |
|---|---|
| tmux | a tmux session is the window: `new-window -d` in the session holding the repo, otherwise a new detached session named after the repo. Focus never moves |
| **Terminal.app** | the window is brought to the front, then Cmd-T and `do script` (needs Accessibility, like restore) |
| iTerm2 | `create tab` in the window showing a session of the repository |
| kitty | `launch --type=tab --match window_id:<a window in it>` |
| WezTerm | `wezterm cli spawn --pane-id <a pane in it>` |
| Ghostty | Cmd-T in the front window. Ghostty cannot target a window from a script |
| Windows Terminal | a new tab in the current window |

### A tab per thread, grouped

Within a repository's window, a session's tabs are grouped by thread. Each session's restore
record keeps the thread its hook last heard. A new tab of a thread (a spawned agent, "show me",
a restored session, a gather fallback) goes right after the thread's last live tab in that
window, where the terminal can place a tab at all. Several at once land in order after it.

| Terminal | A thread's new tab |
|---|---|
| tmux | `new-window -d -a -t <window id of the thread's last window>`. The last window is the highest window index, asked of tmux at that moment. Several are opened last first, so they end up in order |
| kitty | `launch --type=tab --location=after --match window_id:<the thread's tab>` |
| WezTerm | `spawn --pane-id <the thread's pane>`, so it opens in that window, at the end. `wezterm cli` has no command to move a tab |
| Terminal.app, iTerm2 | at the end of the window. Neither can put a new tab anywhere else, or reorder tabs, from a script |
| Ghostty, Windows Terminal | at the end, as before |

A restore opens tabs by repository, then by thread (each thread where its first tab was), then
in their old order. So even where a tab cannot be placed, a thread's restored tabs sit together.
Tab titles carry the thread too: a spawned agent is named `auth · auth-1` from its first hook,
and every other session takes its threads' title from the daemon (`auth · api`).

**Existing tabs are never moved.** Terminal.app cannot move a tab between windows from a
script, and neither can Ghostty or Windows Terminal. In terminals that could, moving a tab
while you work in it would be a surprise. So crosstalk only places new tabs. A window that
already mixes repositories stays mixed.

## Cleaning up worktrees

Nothing in use is removed: a worktree with a process working in it is kept,
and one with a crosstalk service running in it (`crosstalk_serve`) is removed
only after the person's yes, which stops the service first
([services.md](services.md)).

A worktree crosstalk made is finished when both of these are true:

- its branch is merged into the default branch, or the branch was deleted
- its session has ended

The default branch is origin's HEAD, otherwise `main` or `master`. A branch with no commits of
its own is not treated as merged. When a crosstalk worktree is finished, crosstalk offers once
to remove it. With the mod, the offer is a picker; without it, a message. You can also say
"clean up the worktrees" (`crosstalk_cleanup`, or `crosstalk cleanup --yes`).

Removing a worktree takes three steps:

1. crosstalk runs `git worktree remove`, which refuses a worktree with changes.
2. It runs `git worktree prune`.
3. It deletes the merged branch with `git branch -d`, which refuses an unmerged branch.

The answer says how much space was freed. The main checkout's `node_modules` is never
touched, because only the link to it is removed.

Worktrees that crosstalk did not make are listed separately. They are removed only when you
name them (`include`, or `--include <path>`).
