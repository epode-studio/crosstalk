# Services: long-running processes that outlive sessions

crosstalk sometimes ends a Claude session: gather restarts a session that
started before crosstalk in its own tab ([restore.md](restore.md)), a session
whose context is spent can start fresh from its thread instead of compacting
([attention.md](attention.md)), and cleanup removes finished worktrees
([terminal.md](terminal.md)). Claude Code ends its own background shells when it
exits, so a dev server, a watcher or a test run an agent started with a
backgrounded Bash call would die with the session, and cleanup could remove a
folder something is still running in. Four things stop that.

Code: `src/services/`. Tests: `test/services.test.ts`, `test/services.sh`.

## 1. Services outlive sessions

Three actions of `crosstalk_work` ([tools.md](tools.md)):

| Call | What it does |
|---|---|
| `crosstalk_work {action: "serve", command, name?, cwd?, port?}` | Runs the command as a service of this worktree. Its description tells agents to use it instead of a backgrounded Bash call for anything long-running: `npm run dev`, a watcher, `docker compose up`. |
| `crosstalk_work {action: "services", name?, tail?}` | Lists this worktree's services, their state, the ports they listen on and their URLs; with `name` and `tail`, the last lines of one's log. |
| `crosstalk_work {action: "stop", name}` | Stops one. |

**Where it runs.** In crosstalk's private tmux server (`tmux -L crosstalk`, the
one background agents use), in a tmux session called `crosstalk-services`, one
window per service. A service is keyed by its worktree's top folder and its
name: one `web` per worktree. A second `crosstalk_work action "serve"` of a name already
running there says so and starts nothing.

**Its environment.** It is the agent's own request in the person's own session,
so it gets the same trust as a Bash call: the session's own environment, with
two things taken out, by shipping's rule (`src/shipping/git.ts` safeEnv): every
flag provider's variable (`UNLEASH_*`, `LAUNCHDARKLY_*`, …) and anything named
like a secret (`*_TOKEN`, `*_API_KEY`, `*_SECRET`, …), plus crosstalk's,
Claude Code's and tmux's own (`CROSSTALK_*`, `CLAUDE_CODE_*`, `ANTHROPIC_*`,
`TMUX`). The window runs `env -i` with exactly that, so the tmux server's own
environment never leaks in. Then the worktree's ports (below).

**Its output** goes to a log file, `<crosstalk home>/services/logs/<id>.log`,
never into the model's context unless the agent asks with
`crosstalk_work {action: "services", name, tail}`, which returns the last lines (at most 400 and
16 KB) without escape sequences, marked as the service's own output.

**Without tmux** (native Windows, mostly), a service is a detached process in a
process group of its own, with the same log and the same environment. It
outlives the MCP server that started it the same way; stopping it signals the
group.

**The next session is told.** At SessionStart in a worktree with services
running, the person sees a line (systemMessage): `◢ crosstalk: still running in
this worktree: web (http://localhost:4100). This session can reuse it.` The
agent gets one line in its context, framed as a status report, not an
instruction: which services run, on which ports and URLs, that it can reuse
them, and how to read a log or stop one. After a compaction or `/clear` the
agent's line is given again; the person's is not.

## 2. Each worktree gets its own ports

A block of ten ports, from 4100 up in steps of ten (`CROSSTALK_PORT_START`
moves the start), is given to a worktree when crosstalk creates it
(`src/spawn.ts`) or when a session first starts in it (any git checkout). It is
kept in `<crosstalk home>/ports.json`, by the worktree's top folder:

- **stable**: the same worktree gets the same block every time
- **unique**: no two worktrees share a port; a block overlapping one already
  given out is skipped
- **free**: a block with any port listened on when it is handed out is skipped
- **given back** when cleanup removes the worktree, or when its folder is gone

A service gets `PORT` (the block's first port not already used by another of
the worktree's services or by anything listening, unless `port` names one),
`CROSSTALK_PORT_BASE` and `CROSSTALK_PORTS` (the ten, comma-separated). The
session's brief at SessionStart names the block.

**The ports a service actually listens on** are looked up from its process
tree: the tmux pane's first process and everything below it, matched against
`ss -ltnpH` on Linux, else `lsof -nP -iTCP -sTCP:LISTEN` (macOS, and Linux
without ss). `crosstalk_work action "serve"` waits up to three seconds for the server to bind
so it can say where it listens.

**Where they show.** After the session's title on its tab (`auth · :4100`,
the number and nothing more, or the worktree's name through crosstalk's proxy
while it is up, `auth · auth.localhost:1355`: [urls.md](urls.md)), on the mod's status line (`◢ auth · :4100 · 0
waiting`), and in the thread pane under Services, each with a link to
`http://localhost:<port>` (an OSC 8 hyperlink in the terminal).

## 3. crosstalk waits, silently, for anything started outside it

Before gather's restart in place and before a fresh session replaces one,
crosstalk looks below the Claude process (`src/services/postpone.ts`):

- **counted**: every process below a shell that Claude spawned (its Bash tool
  runs each command in one, background ones included), and any port listened on
  from there
- **left out, as Claude Code's own**: what Claude spawns directly (MCP servers,
  hooks, ripgrep) and everything below them; shells with nothing running in
  them; crosstalk's own processes (its watch and pane, by their command line);
  crosstalk's services, which outlive the session anyway

If anything is counted, the end is postponed, with no question, and tried again
when it has stopped:

- **gather** treats the session as busy: it waits in the same detached waiter,
  looking every two seconds (one `ps`), for up to two hours, then reports it
  as never having gone idle.
- **a fresh session** (the person's "Start fresh", or the standing rule) waits,
  looking every 15 seconds (`CROSSTALK_POSTPONE_POLL_MS`) for up to two hours
  (`CROSSTALK_POSTPONE_UNTIL_MS`). If the context fills up while it waits, the
  PreCompact is let through: Claude Code compacts as usual, the wait is called
  off, and nothing is ended.
- **sending a session to the background** (`crosstalk_work action "background"`, after the
  person's yes) waits the same way, in a detached waiter (`crosstalk ui
  bg-later`) that takes that one yes and moves the session once nothing it
  started still runs, for up to two hours.
- **closing a session** (`crosstalk_work action "close"`) is the person's own explicit
  request, so it does not wait: the question says what it would interrupt
  ("Close api? It is still running npm run dev, which stops with it."), and the
  receipt says what stopped with it. Its crosstalk services keep running unless
  the person says to stop them too (the session manager asks this module
  through `setServices`, src/sessions/services.ts).

## 4. Services stop with the thread; nothing in use is removed

Cleanup (`crosstalk_work action "cleanup"`, the "Remove them" picker) and disk freeing never
remove a worktree that:

- has a process whose working directory is inside it (which covers one
  listening from inside it), found from `/proc` on Linux and `lsof -d cwd`
  elsewhere: it is listed as "still in use", with the process
- has a crosstalk service running in it, without the person's yes

When a thread's worktree is offered for removal and has services, the offer
says so ("Its service (web · :4100) stops first."). After the person's yes,
each service is stopped first, SIGTERM to its process tree, a wait (up to eight
seconds, `CROSSTALK_SERVICE_STOP_MS`), then its tmux window closed (SIGHUP) and
another wait, and only then is the worktree removed. Removing without that yes
refuses while a service runs. Disk freeing (`src/disk/`) keeps any worktree
with a service running in it.

A session that was closed (its record kept in `<crosstalk home>/open/` with
`archived` and `endedAt`) counts as ended for cleanup, but the in-use check
still applies: a dev server it left running in the worktree keeps it.

## Not yet checked in real use

- **On a Mac:** the `lsof` paths (listening ports, working directories), the
  tmux server started from the MCP server inside Claude Code, and the mod's
  link in the pane.
- **Claude Code's own process tree:** the shell-below-claude rule was checked
  against stub sessions; a real Claude Code's Bash tool and its background
  shells, and MCP servers that run their own children, should be looked at.
