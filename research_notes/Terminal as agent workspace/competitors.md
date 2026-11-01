# Multi-agent coding workspaces: UI, session management, and what a terminal-only tool can match

Scope: herdr, Paradev (ex-Superset), Conductor, claude-squad, cmux, Claude Code agent view, Codex app, Zed parallel agents, Vibe Kanban / Crystal / Nimbalyst. Research date: 2026-11-01. About 18 tool calls. Many claims come from vendor pages or secondary blogs; these are flagged.

## Q1. What each tool's UI looks like, and what it is built on

### Takeaway
Every GUI competitor uses the same layout: a sidebar of agents/workspaces grouped by repo with a status dot, a real terminal or chat pane, and a diff/changes pane. They differ in stack (Electron for Paradev, Tauri for Conductor, libghostty for cmux, native Rust for Zed) and in whether the center pane is the agent's real TUI ("terminal-centric": herdr, Paradev, cmux, claude-squad) or the vendor's own chat rendering ("chat-centric": Conductor, Codex app). Claude Code now ships its own TUI session list (agent view), which shrinks the gap a terminal-only tool needs to cover.

### Cited Findings
**herdr**
- herdr is a native app for running coding agents such as Claude Code and Codex. Agents run in herdr-core, a small local server, so they survive closing, updating, or crashing the app. A reboot or herdr-core stop kills them. Panes then reopen with a shell in the same folder, but agents are not resumed — [herdr.dev](https://herdr.dev)
- "Use a space for each repo and a tab for each task." A sidebar and tabs show which agent needs you. Remote SSH machines appear in the same sidebar (`hc machine add vps`) — [herdr.dev](https://herdr.dev)
- Orchestration: `hc run --bg codex "review my diff. Done: hc send t1"`. `hc send t3 "take another look"` steers a running helper, and helper reports arrive in the requesting agent's input tagged `<hc from="t3 reviewer">` — [herdr.dev](https://herdr.dev)
- Config lives in `~/.config/herdr-app` (AGENTS.md, settings.json with fonts/theme/sounds, keys.json, layouts/, mods/, themes/). The user's agent edits these files to customise the app. Apache 2.0, with repos herdr-app, herdr-core, and herdr (a separate TUI). Platforms: macOS arm, Linux x86_64/arm64, Windows — [herdr.dev](https://herdr.dev)
- The herdr TUI is written in Rust (`src/pane/osc.rs`) — [herdr discussion #5073](https://github.com/herdrdev/herdr/discussions/5073)
- The site does not name its terminal engine (libghostty unverified) and does not mention worktrees — [herdr.dev](https://herdr.dev)

**Paradev (formerly Superset)**
- A desktop "agentic IDE". Each task gets its own git worktree, branch, and terminals. The sidebar shows working/done/waiting. Stack: Electron, React, Tailwind, Bun, Turborepo, Vite, Drizzle, Neon, tRPC. ELv2 license, about 15.8k stars. The CLI is still `superset` — [GitHub superset-sh/superset](https://github.com/superset-sh/superset)
- Setup/teardown/run scripts are configured in `.superset/config.json`. An in-app browser pane previews dev servers, with ports detected per workspace. A Changes pane lets you inspect, comment on, and edit agent changes, then commit and push. PR review, checks, and merge happen in-app. It also offers one-click handoff to Cursor or VS Code — [GitHub](https://github.com/superset-sh/superset)
- The iPhone/iPad app controls agents in cloud workspaces or on a connected computer. It needs Paradev Pro and iOS 26+. Remote Access reaches another machine's workspaces and can wake offline hosts with a custom command — [GitHub](https://github.com/superset-sh/superset)
- Pricing: free tier and Pro at $20/seat/month (vendor page, unverified) — [superset.sh compare](https://superset.sh/compare/superset-vs-agent-orchestrator)
- Launches Claude Code, Codex, OpenCode, Cursor Agent, Copilot, Gemini CLI, Mistral Vibe (vendor page) — [superset.sh compare](https://superset.sh/compare/superset-vs-zed)

**Conductor (conductor.build)**
- A Mac app for running Claude Code, Codex, Cursor, and OpenCode in parallel. Each task gets an isolated workspace with its own branch, files, terminal, diff, and review path. The flow is review diff, open PR, merge, archive workspace. Docs list Diff viewer, Checks, Agent modes, and a Conductor API — [Conductor docs](https://www.conductor.build/docs/)
- Workspaces are git worktrees, with setup scripts and a per-workspace `CONDUCTOR_PORT` env var. Docs state that "workspace isolation is not a security boundary" — [Conductor docs: workspaces](https://www.conductor.build/docs/concepts/workspaces-and-branches)
- Built on Tauri with a Rust backend and mostly TypeScript, plus a small Phoenix/Elixir web app. Sources conflict on the renderer ("Safari web renderer" vs "native Mac renderer") — [launch thread](https://threadreaderapp.com/thread/1945870105109246401.html); [YC interview](https://rosetta.to/u/ycombinator/conductor-ceo-charlie-holtz-walks-us-through-his-ai-coding-setup)
- macOS only — [aggregator](https://nathan-norman.vercel.app/ai-stacks/conductor)
- HN users describe Conductor as "chat-centric" (its own rendering of agent output) and Superset as "terminal-centric". One user switched from Conductor to avoid its text rendering. There is a mention of Conductor's "big terminal mode" — [Launch HN: Superset](https://news.ycombinator.com/item?id=48236770)

**claude-squad (`cs`)**
- A Go TUI. Each agent runs in its own tmux session with a git worktree. It supports Claude Code (default), Codex, Gemini, and Aider via `-p` or profiles. It has preview and diff tabs and a bottom command menu. Requires tmux and `gh`. About 8.7k stars — [GitHub smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad)
- Keys: `n`/`N` new (with prompt), `D` delete, `j/k` navigate, `↵/o` attach, `ctrl-q` detach, `s` commit+push, `c` checkout (commit and pause), `r` resume, `tab` preview/diff, `shift-↑/↓` scroll diff, `?` help. Experimental `-y/--autoyes` auto-accepts prompts — [GitHub](https://github.com/smtg-ai/claude-squad)
- Known failure: "timed out waiting for tmux session" — [GitHub](https://github.com/smtg-ai/claude-squad)

**cmux**
- A macOS terminal built on libghostty that reads the user's Ghostty config. Panes get a blue ring and tabs light up when an agent needs attention. A notification panel jumps to the newest unread item. It reads OSC 9/99/777 and provides `cmux notify` for agent hooks. `cmux claude-teams` opens Claude Code teammates as native splits with sidebar metadata. Active Claude Code/tmux/vim sessions are not resumed after restart. Sourced from forks/mirrors, not a confirmed official repo — [fork](https://github.com/mp-grind/cmux); [fork](https://github.com/can1357/cmux)
- Motivation quoted in the fork: Claude Code's notification body is always "Claude is waiting for your input" with no context — [fork](https://github.com/mp-grind/cmux)

**Claude Code agent view / background sessions (first-party, TUI)**
- Launched as a research preview on 2026-05-11. Open it with the left arrow from a session or `claude agents`. Rows show the session, whether it needs input, its last response, and time of last interaction. Peek shows the last turn, and you can answer a pending decision inline. Enter attaches, and the right arrow returns to the session. Looping jobs show their next run time. `/bg [prompt]` backgrounds the current session, and `claude --bg [task]` starts one — [Claude blog](https://claude.com/blog/agent-view-in-claude-code)
- A per-user supervisor process keeps background sessions alive apart from the terminal. Third-party guides list `claude attach`, `claude logs`, `claude stop`, and `claude respawn` (unverified against docs) — [Pillitteri blog](https://pasqualepillitteri.it/en/news/2384/claude-code-agent-view-cli-dashboard-sessions-2026); [claudefa.st](https://claudefa.st/blog/guide/agents/agent-view)
- The official post does not mention worktrees or notifications for agent view — [Claude blog](https://claude.com/blog/agent-view-in-claude-code)

**Codex app (OpenAI)**
- Launched 2026-02-02 on macOS with parallel agent threads, a project sidebar, and built-in review. Windows followed in March. Threads are a logical grouping and worktrees provide the isolation. A reported limit of 15 worktrees, plus detached HEAD and handoff. These come from secondary guides — [Verdent first impressions](https://verdent.ai/guides/codex-app-first-impressions-2026); [Verdent worktrees](https://www.verdent.ai/guides/codex-app-worktrees-explained)
- One July 2026 guide says that since 2026-07-09 it is no longer a standalone download but a Codex mode inside the ChatGPT desktop app (single secondary source, unverified) — [heyuan110 guide](https://www.heyuan110.com/posts/ai/2026-07-12-openai-codex-app-guide/)

**Zed parallel agents**
- Zed 1.0 (around 2026-04-29) added a Threads sidebar grouped by project. The Project and Git panels moved to the right. Threads can be Zed's agent or external agents over ACP (Claude Code, Codex), with optional worktree isolation. Zed is a native Rust GPU editor — [Zed docs](https://zed.dev/docs/ai/parallel-agents); [Zed blog](https://zed.dev/blog/parallel-agents); [AlternativeTo](https://alternativeto.net/news/2026/4/zed-launches-parallel-agent-orchestration-with-a-threads-sidebar-to-control-and-monitor-them/)

**Vibe Kanban / Crystal / Nimbalyst**
- Vibe Kanban: its maker bloop announced shutdown on 2026-04-10, and cloud features were turned off 30 days later. The open-source local version is community-maintained — [vibekanban.com/shutdown](https://vibekanban.com/shutdown); [Nimbalyst blog (competitor)](https://nimbalyst.com/blog/vibe-kanban-after-bloop-whats-next/)
- Crystal was deprecated in Feb 2026 and replaced by Nimbalyst (from the same maker, Stravu) — [project-awesome](https://project-awesome.org/r/stravu-crystal)
- Sculptor (Imbue), Terragon, and Warp were not researched successfully. See Gaps.

### Inferences
- The shared minimum UI is: grouped list of agents + status badge + attach to real TUI + diff + worktree lifecycle (create, setup script, archive). tmux already gives sessions, windows, and a status line. Claude Code agent view already gives a per-agent list with needs-input state and inline answers.
- The market is consolidating. Vibe Kanban and Crystal are gone, and the first-party tools (Claude agent view, Codex app, Zed) are taking the "list of agents" role. That favours a thin layer over the user's terminal rather than another app.

### Gaps
- herdr's rendering engine and whether herdr-app uses libghostty are not confirmed.
- Conductor's mechanism for running Claude Code (Agent SDK vs CLI in a PTY) is not confirmed.
- Sculptor (Imbue), Terragon, Warp agent features (Agents 3.0 / agent management panel), and Nimbalyst internals were not fetched because of the tool budget.
- cmux details come from forks. The official repo or site (likely manaflow-ai/cmux) was not verified.

## Q2. How each tool detects agent status (working / waiting / needs input)

### Takeaway
There are four techniques: (1) screen scraping (claude-squad pane-hash plus prompt strings; herdr title-spinner rules), (2) agent hooks calling a notify CLI (cmux `notify`, Superset hooks), (3) terminal notification OSCs (9/99/777, title OSC 0/2), and (4) the new OSC 7501 Program Status Protocol, which Claude Code itself now emits with permission, question, and auth reasons. OSC 7501 is the strongest finding for crosstalk: a tmux-based tool can get first-class status without scraping, but only if something answers the capability query, and tmux does not do that today (unverified).

### Cited Findings
- **OSC 7501 wire format.** Report: `ESC ] 7501 ; key=value:key=value ESC \` (or BEL). Keys match `[a-z]+` and values match `[A-Za-z0-9_.,+/=-]*`. Example: `OSC 7501 ; state=working:app=brew:msg=SW5zdGFsbGluZyB1cGRhdGVz ST` — [Program Status spec](https://superlogical.com/rex/docs/build/program-status)
- **Handshake.** Query `OSC 7501 ; ?`, reply `OSC 7501 ; ? : states=idle,working,done,blocked,error : kinds=permission,question,auth`. The spec suggests sending `CSI c` (DA1) right after the query so a program doesn't hang waiting on terminals that never reply — [spec](https://superlogical.com/rex/docs/build/program-status)
- **Keys.** `state` (required: idle, working, done, blocked, error, clear; unknown values void the report), `kind` (permission/question/auth, blocked only), `app` (≤32 bytes), `msg` (base64, ≤2048 decoded), `progress` (0–100), `id` (slash path, ≤8 levels), `title` (base64, ≤192 decoded). The whole sequence is capped at 4096 bytes — [spec](https://superlogical.com/rex/docs/build/program-status)
- **Lifetime.** Each report replaces its record entirely, with no heartbeat. `working`/`blocked` end at process exit or the next shell prompt (OSC 133 A). `done`/`error` survive exit. `clear` with no id removes all records. RIS clears and DECSTR does not. Terminals hold at most 256 records with LRU eviction. Spec revisions 0.1–0.4 date from 2026-09-28 to 2026-10-10 — [spec](https://superlogical.com/rex/docs/build/program-status)
- **Author.** Attributed to Mitchell Hashimoto by the herdr discussion and press. The spec page itself names no author — [herdr #5073](https://github.com/herdrdev/herdr/discussions/5073); [zeli.app](https://zeli.app/ja/story/49984159)
- **Claude Code emits OSC 7501.** Support was added in 2.1.295 and is gated on the query reply. Behaviour tested on 2.1.312:
  - idle when ready, working when a turn starts, done when it ends
  - blocked/permission on approval prompts, blocked/question on questions, blocked/auth on login issues
  - error on a bad model name, clear on `/exit`
  - Esc mid-turn sends idle, not done
  - Once the query is answered, Claude stops drawing spinner glyphs in the title, so title-scraping breaks
  - Gaps: the folder-trust dialog emits nothing, and an unreachable API stayed `working` for 25 seconds
  - Pi 1.1.0, pi-subagents 0.77.0, and Ghostty also support it

  Source: [herdr discussion #5073](https://github.com/herdrdev/herdr/discussions/5073)
- **herdr today.** As of 0.9.3 the TUI's OSC observer handles only OSC 0/2/9. Detection is screen-based with per-agent TOML rules (e.g. `claude.toml` `osc_title_working` matching spinner glyphs), plus Pi lifecycle hooks. It does not answer the 7501 query, so records are dropped. The herdr.dev site, by contrast, says agents that support OSC 7501 report status, which suggests herdr-app has since adopted it or is ahead of the TUI. Agents running inside tmux within herdr cannot report status — [herdr #5073](https://github.com/herdrdev/herdr/discussions/5073); [herdr.dev](https://herdr.dev)
- **TUIOS** implements 7501 with a `tuios status <state> --kind --app --msg --progress` CLI and `--clear`. It says no hook, socket, or plugin is needed. T3 Code has an open request to consume it — [TUIOS wiki](https://github.com/Gaurav-Gosain/tuios/wiki/Program-Status); [t3code discussion](https://github.com/pingdotgg/t3code/discussions/17946)
- **claude-squad.** Uses `tmux capture-pane -p -e -J` each tick and compares a SHA-256 of the pane with the previous tick (a change means updated/working). It string-matches prompts: Claude "No, and tell Claude what to do differently", Aider "(Y)es/(N)o/(D)on't ask again", Gemini "Yes, allow once". It auto-dismisses "Do you trust the files in this folder?" and "new MCP server" by sending Enter — [claude-squad tmux.go](https://raw.githubusercontent.com/smtg-ai/claude-squad/main/session/tmux/tmux.go)
- **cmux** reads OSC 9/99/777 and offers a `cmux notify` CLI for Claude Code/OpenCode hooks (fork-sourced) — [fork](https://github.com/mp-grind/cmux)
- **Superset.** The original Show HN said built-in hooks notify you when agents finish or need attention. A vendor page cites working indicators, completion chimes, and dock badges. The exact mechanism isn't documented in the README — [Show HN: Superset](https://news.ycombinator.com/item?id=46368739); [superset.sh](https://superset.sh/compare/superset-vs-agent-orchestrator)
- **Claude agent view** shows needs-input/working/done natively. As a first-party tool it has internal state, with no scraping — [Claude blog](https://claude.com/blog/agent-view-in-claude-code)

### Inferences
- crosstalk options, best first:
  - (a) Answer the OSC 7501 query for Claude panes and parse the records. In tmux this likely needs a PTY proxy or wrapper between tmux and `claude`, because tmux would have to pass the query through and return a reply. tmux's native 7501 support was not verified, and the spec's DA1 trick means Claude simply won't emit if nobody replies.
  - (b) Claude Code hooks (Notification, Stop, UserPromptSubmit, PreToolUse) writing state to the daemon. These work without terminal cooperation.
  - (c) Pane scraping via `capture-pane` as a fallback, especially for the folder-trust dialog, which emits nothing under 7501.
- A wrapper that answers 7501 also suppresses Claude's title spinner, so don't rely on both at once.

### Gaps
- Whether tmux (3.5/3.6) forwards or answers OSC 7501 was not checked. This is critical for crosstalk and should be tested.
- Whether Claude Code's 7501 emission can be forced by env var without a query reply is unknown.
- Paradev's and Conductor's actual detection code was not inspected.

## Q3. How each tool spawns agents

### Takeaway
All of them except Zed's built-in agent spawn the vendor CLI (`claude`, `codex`, …) in a PTY inside a fresh git worktree, run a repo-configured setup script, and assign a port. The PTY host varies: tmux for claude-squad, a local server (herdr-core) for herdr, the Electron main process for Paradev (implementation unverified), and the Claude supervisor for agent view. Zed uses ACP for external agents.

### Cited Findings
- claude-squad: a tmux session per agent plus a git worktree and branch. The program is chosen via `-p`/profiles — [GitHub](https://github.com/smtg-ai/claude-squad)
- herdr: real terminals owned by herdr-core, so they survive app quit. Agents spawn helpers with `hc run --bg <agent> "<prompt>"` and get results back via `hc send` — [herdr.dev](https://herdr.dev)
- Paradev: worktree, branch, and terminals per task, with setup/teardown/run scripts in `.superset/config.json`. Persistence: an HN user said a Claude Code session survived an app update — [GitHub](https://github.com/superset-sh/superset); [Launch HN](https://news.ycombinator.com/item?id=48236770)
- Conductor: worktree per workspace, setup scripts, `CONDUCTOR_PORT` — [Conductor docs](https://www.conductor.build/docs/concepts/workspaces-and-branches)
- Claude Code: `claude --bg [task]` / `/bg` hand the session to a per-user supervisor — [Claude blog](https://claude.com/blog/agent-view-in-claude-code); [Pillitteri](https://pasqualepillitteri.it/en/news/2384/claude-code-agent-view-cli-dashboard-sessions-2026)
- Zed: external agents over ACP, optional worktree — [Zed docs](https://zed.dev/docs/ai/parallel-agents)
- Codex app: threads with optional worktrees, about 15 worktree limit (secondary) — [Verdent](https://www.verdent.ai/guides/codex-app-worktrees-explained)

### Inferences
- crosstalk can match spawning fully with `git worktree add`, a setup script, `tmux new-window -c <wt> 'claude ...'` (or `claude --bg`), and a port allocated by the daemon and exported as an env var (like `CONDUCTOR_PORT`). tmux-server persistence is equivalent to herdr-core's: it survives terminal close but not reboot.

### Gaps
- Whether Conductor uses the Agent SDK (which matters for the "programmatic usage" metering mentioned on HN) is unverified.

## Q4. What users praise and complain about

### Takeaway
Users praise parallelism at scale (40–50 sessions), worktree isolation, session persistence, remote boxes, and running the agents' native TUIs. They complain about Electron weight (a "2GB" app), rendering glitches in long sessions, login walls, Mac-only builds, a $20/month price, and port/Docker juggling. A visible minority says "tmux / iTerm tabs is plenty", which is crosstalk's target user.

### Cited Findings (all from [Launch HN: Superset](https://news.ycombinator.com/item?id=48236770) unless noted)
- Praise:
  - micro23xd: "running probably 40-50 agent sessions over several repos simultaneously without any issues and losing track"
  - cpan22: native Claude Code/Codex TUIs "without any of the bloat"
  - bicepjai: a session survived an app update
  - joshgachnang: remote dev box is "exactly what I've been looking for"
- Weight and bugs:
  - desireco42: "vibe coded electron app, 2GB! is too much for this kind of app", with freezing. Moved to Zellij.
  - micro23xd and avipeltz: garbled characters in long sessions, worse on 4K, possibly a WebGL context bug
- Setup and ports:
  - igor47: setup scripts are "doing a lot of heavy lifting"
  - toddmorey: "I've never used lsof so much in my life"
  - nullbio asked about Docker services and unique local URLs
- Friction:
  - tacone: login wall, unexpected OpenCode download, no model selection
  - "Why Mac only?" (Linux build less maintained, no Windows)
  - tdi: $20/month "a bit steep"
- Terminal-is-enough:
  - hmokiguess: "iTerm2 tabs / tmux is plenty", and Warp "feel[s] so heavy"
  - whinvik: "NeoVim setup + tmux + Ghostty is good enough"
  - gchamonlive: a terminal with Linux tools is already an IDE
- Pricing risk: collin128 noted Anthropic's June 15 pricing change may meter Conductor as programmatic usage
- Worktree skepticism on the original Show HN: "git worktrees are a bad approach" — [Show HN](https://news.ycombinator.com/item?id=46368739)
- cmux's motivation: Claude's notification text has no context — [fork](https://github.com/mp-grind/cmux)

### Inferences
- The "another app" objection shows up as weight, rendering, platform, and pricing complaints rather than in those exact words. crosstalk sidesteps all four by reusing the user's terminal and Claude subscription via the CLI.
- Rendering fidelity is a plus for real terminals: a native terminal (Ghostty/iTerm/kitty + tmux) avoids xterm.js/WebGL glitches.

### Gaps
- No Conductor-specific HN complaint thread was fetched. There are no Reddit sources.

## Q5. Element-by-element verdict: can tmux + escape codes + Claude Code hooks match it?

### Takeaway
crosstalk can fully match the list of agents, status, notifications, attach and persistence, spawning, worktree lifecycle, setup scripts, ports as env vars, keyboard shortcuts, and agent-to-agent messaging. It can partially match diff review, port previews, remote hosts, and cross-device notifications. It cannot match in-terminal rich UI such as inline diff commenting with a mouse, an embedded browser preview, or a native iOS app without leaning on other tools (claude.ai, GitHub, `$EDITOR`).

### Cited Findings and verdicts
| Element | Seen in | Verdict for tmux + OSC + hooks |
|---|---|---|
| Sidebar list of agents grouped by repo/task | herdr spaces/tabs, Paradev, Conductor, Zed, Codex | **Match.** tmux sessions = spaces, windows = tabs. A `choose-tree` or popup picker plus status-line badges, as claude-squad does in a TUI ([claude-squad](https://github.com/smtg-ai/claude-squad)). Claude agent view already lists sessions ([Claude blog](https://claude.com/blog/agent-view-in-claude-code)). |
| Working/blocked/done status | all | **Match.** Claude Code emits OSC 7501 with permission/question/auth reasons once the query is answered ([herdr #5073](https://github.com/herdrdev/herdr/discussions/5073)). Hooks are the fallback. A daemon sets tmux window options/format strings. Caveat: the folder-trust dialog emits nothing, and tmux pass-through is unverified. |
| Attention highlight / notification | cmux blue ring, Paradev chimes/dock badges | **Match (local), partial (rich).** tmux `monitor-bell` / window style changes, OSC 9/777 desktop notifications through the outer terminal, and hooks can add context that the default Claude message lacks ([cmux fork](https://github.com/mp-grind/cmux)). |
| Peek and answer inline | Claude agent view | **Partial.** `capture-pane` into a popup plus `send-keys`, or just use `claude agents` ([Claude blog](https://claude.com/blog/agent-view-in-claude-code)). |
| Persistence across app/terminal close | herdr-core, Claude supervisor | **Match.** The tmux server persists the same way. Neither survives a reboot ([herdr.dev](https://herdr.dev)). |
| Worktree per task + setup/teardown/run scripts | Paradev `.superset/config.json`, Conductor | **Match.** The daemon runs `git worktree add` and the scripts ([GitHub](https://github.com/superset-sh/superset)). |
| Per-workspace ports | Conductor `CONDUCTOR_PORT`, Paradev port detection | **Match** for allocation via env var. **Partial** for detection, using `lsof`/`ss` polling ([Conductor docs](https://www.conductor.build/docs/concepts/workspaces-and-branches)). |
| Preview browser pane | Paradev | **No.** At best, open a URL in the system browser via OSC 8 hyperlinks ([GitHub](https://github.com/superset-sh/superset)). |
| Diff viewer / review with comments | Paradev Changes pane, Conductor diff viewer + checks, claude-squad diff tab | **Partial.** `git diff` / delta / lazygit / nvim in a split, as claude-squad's diff tab is text-only ([claude-squad](https://github.com/smtg-ai/claude-squad)). Commenting and editing in a GUI pane is not available. GitHub PR review covers the rest. |
| Commit/push/PR/merge/archive | claude-squad `s`/`c`, Conductor | **Match** via keybindings calling `git`/`gh`. |
| Open in IDE | Paradev | **Match** via `code <wt>` / `cursor <wt>` / `$EDITOR`. |
| Agent-to-agent spawn & messaging | herdr `hc run --bg` / `hc send` | **Match** via a daemon CLI plus `tmux send-keys` or Claude Code channels/hooks ([herdr.dev](https://herdr.dev)). |
| Remote hosts | herdr SSH machines, Paradev Remote Access | **Partial.** SSH + tmux on the remote is native. A unified multi-host sidebar needs the daemon to aggregate. |
| Mobile app | Paradev iOS (Pro) | **No** native app. **Partial** via SSH clients (Blink/Termius) + tmux, or Claude's own remote/mobile surfaces ([GitHub](https://github.com/superset-sh/superset)). |
| Keyboard-first operation | claude-squad keys, herdr keys.json | **Match.** tmux key tables ([claude-squad](https://github.com/smtg-ai/claude-squad)). |
| Rendering fidelity on long sessions | Paradev complaints | **Better than the apps.** The native terminal avoids xterm.js/WebGL glitches ([Launch HN](https://news.ycombinator.com/item?id=48236770)). |
| Kanban/task board | Vibe Kanban (shut down), Paradev board | **Partial.** A TUI list. Low demand signal, since Vibe Kanban shut down ([vibekanban.com/shutdown](https://vibekanban.com/shutdown)). |

### Inferences
- crosstalk's positioning: everything herdr does for status and orchestration, inside tmux, plus Paradev/Conductor worktree, script, and port lifecycle, with review delegated to existing CLI tools (delta, lazygit, gh) and the IDE.
- Biggest technical risk: getting OSC 7501 from a `claude` running inside tmux. herdr itself notes that agents inside tmux can't report status ([herdr.dev](https://herdr.dev)). Hooks are the dependable baseline, and 7501 is an upgrade if crosstalk wraps the PTY or tmux adds support.

### Gaps
- Not verified: tmux handling of OSC 7501 and OSC 9/777 pass-through (`allow-passthrough`), Claude Code's hook event list as of late 2026, and whether agent view exposes machine-readable state that crosstalk could read.
