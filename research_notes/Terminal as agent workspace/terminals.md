# Terminal as agent workspace: per-terminal capability matrix (iTerm2, kitty, WezTerm, Ghostty, Terminal.app, Windows Terminal, VS Code)

Researched 2026-11-01. Convention: anything under "Cited Findings" was confirmed this session from the linked page. Items marked **[TK]** in Inferences come from the researcher's training knowledge (cutoff mid-2026). They were NOT re-fetched this session and should be checked before anyone relies on them. Escape notation: `OSC` = `ESC ]` (`\e]`), `ST` = `ESC \` (`\e\\`) or BEL (`\a`).

## Q1. Scripting/control API per terminal: what exists, how it is enabled, does it work from a background process

### Takeaway
kitty (`kitten @` over a unix socket) and WezTerm (`wezterm cli` over the GUI/mux socket) are the strongest options for a daemon: both are cross-platform, both answer structured JSON queries, and both reach the terminal from outside it. iTerm2 (Python API plus AppleScript) and Ghostty 1.3+/1.4 (AppleScript, macOS only) are scriptable on macOS from any process, subject to TCC Automation prompts. On Linux, Ghostty has only `+new-window`/`+new-tab` launch commands. Windows Terminal's `wt.exe` is fire-and-forget: it can open tabs and panes and focus a tab by index, and it cannot query anything.

### Cited Findings
- **kitty, enabling:** `allow_remote_control` in kitty.conf, or `-o allow_remote_control=yes`. The value `password` turns on password auth, and `remote_control_password` can limit a password to particular actions. Passwords come from `KITTY_RC_PASSWORD` or `~/.config/kitty/rc-pass`. A custom `is_cmd_allowed` Python hook is possible. Remote control can also be granted per window with `launch --allow-remote-control`. — [kitty remote control](https://sw.kovidgoyal.net/kitty/remote-control/)
- **kitty, external process:** start kitty with `--listen-on unix:/tmp/mykitty` (or set `listen_on` in kitty.conf), then call `kitten @ --to unix:/tmp/mykitty <cmd>`. `kitten @` reads `KITTY_LISTEN_ON` when `--to` is absent. Without a socket, it works only from inside a kitty window (SSH included). — [kitty remote control](https://sw.kovidgoyal.net/kitty/remote-control/)
- **kitty, commands:** `launch`, `new-window`, `focus-tab`, `focus-window`, `close-tab`, `close-window`, `ls`, `set-tab-title`, `set-tab-color`, `set-colors`, `set-background-image`, `set-font-size`, `send-text`, `send-key`, `action`, `set-user-vars`, `set-window-title`, `set-os-window-title`. — [kitty remote control](https://sw.kovidgoyal.net/kitty/remote-control/)
- **WezTerm `wezterm cli` subcommands:** activate-pane-direction, activate-pane, activate-tab, adjust-pane-size, get-pane-direction, get-text, kill-pane, list-clients, list, move-pane-to-new-tab, rename-workspace, send-text, set-tab-title, set-window-title, spawn, split-pane, zoom-pane. Many of them take `--pane-id`. — [wezterm cli](https://wezterm.org/cli/cli/index.html)
- **WezTerm, finding the GUI from outside:** (1) with `--prefer-mux`, the first unix domain in the config; (2) `$WEZTERM_UNIX_SOCKET` if set; (3) otherwise it locates a running GUI instance, and `--class` picks a GUI started with `--class`. When `--pane-id` is omitted, it uses `$WEZTERM_PANE`, falling back to the focused pane of the most recently active client. — [wezterm cli](https://wezterm.org/cli/cli/index.html)
- **Ghostty AppleScript:** added in 1.3.0 (released 2026-03-09) and enabled by default on macOS. Disable it with `macos-applescript = false`. The 1.3.0 notes call it a "preview feature". — [Ghostty AppleScript docs](https://ghostty.org/docs/features/applescript); [Ghostty 1.3.0 notes](https://ghostty.org/docs/install/release-notes/1-3-0)
- **Ghostty AppleScript object model:**
  - application: name, frontmost, front window, version.
  - window: id, name, selected tab.
  - tab: id, name, index, selected, focused terminal.
  - terminal: id, name, working directory.
  - Commands: `new surface configuration`, `new window`, `new tab`, `split` (right/left/down/up), `focus`, `activate window`, `select tab`, `close`, `close tab`, `close window`, `input text`, `send key`, `send mouse button`, `send mouse position`, `send mouse scroll`, `perform action`.
  - — [Ghostty AppleScript docs](https://ghostty.org/docs/features/applescript)
- **Ghostty 1.4.0 (released 2026-10-27) AppleScript additions:**
  - the terminal class exposes the foreground process PID and the TTY;
  - tab and terminal get a read-write `name override` property;
  - `send key` works for character keys;
  - working directories are normalized.
  - — [Ghostty 1.4.0 notes](https://ghostty.org/docs/install/release-notes/1-4-0); [tip changelog 2026-10-26](https://github.com/dive/ghostty-tip-changelog/releases/tag/daily-2026-10-26)
- **Ghostty on Linux (GTK):** 1.4 adds `ghostty +new-tab`, which opens a tab in a running instance and accepts `-e`, `--working-directory` and `--title`. Run from inside Ghostty, it opens in the same window. `+new-window` takes `-e` and `--working-directory` (from 1.3) and `--shell-integration`. 1.4 also adds `+toggle-quick-terminal`. The notes describe no new D-Bus or general Linux scripting API. — [Ghostty 1.4.0 notes](https://ghostty.org/docs/install/release-notes/1-4-0); [Ghostty 1.3.0 notes](https://ghostty.org/docs/install/release-notes/1-3-0)
- **Ghostty App Intents (macOS):** 1.3 adds an intent that focuses a specific terminal, usable from Shortcuts. — [Ghostty 1.3.0 notes](https://ghostty.org/docs/install/release-notes/1-3-0)
- **Ghostty cross-platform scripting API:** a request for one remains an open discussion. — [Discussion #2353](https://github.com/ghostty-org/ghostty/discussions/2353)
- **Ghostty community wrapper:** ghosttpy is a Python wrapper over the AppleScript API (needs 1.3.0+). — [ghosttpy](https://github.com/DylanModesitt/ghosttpy)
- **Windows Terminal `wt.exe`:**
  - Syntax: `wt [options] [command ; ]`.
  - Options include `--window, -w <id|name|new|-1|last|0>`, which sends commands to an existing window (`last`/`0` = most recently used). A window id that does not exist creates a new window.
  - Commands: `new-tab`/`nt`, `split-pane`/`sp`, `focus-tab`/`ft -t <index>`, `move-focus`/`mf`, `move-pane`/`mp`, `swap-pane`.
  - From WSL: `cmd.exe /c "wt.exe" ...`, because execution aliases do not work inside WSL.
  - — [WT command line arguments](https://learn.microsoft.com/en-us/windows/terminal/command-line-arguments)
- **iTerm2 Python API, documented calls:**
  - `Window.async_create_tab(profile=None, command=None, index=None, profile_customizations=None) -> Tab`
  - `Session.async_activate(select_tab=True, order_window_front=True)`
  - `Tab.async_activate`
  - `App.async_activate(ignoring_other_apps=...)`. Window activation alone does not activate the app.
  - — [iTerm2 window API](https://iterm2.com/python-api/window.html); [session API](https://iterm2.com/python-api/session.html); [app API](https://www.iterm2.com/python-api/app.html); [tab API](https://iterm2.com/python-api/tab.html)

### Inferences
- **[TK] iTerm2 Python API:**
  - Enabled in Settings > General > Magic > "Enable Python API". It connects over a unix socket (`~/Library/Application Support/iTerm2/private/socket`; older builds used websocket on localhost:1912).
  - A process not launched by iTerm2 triggers a one-time "allow this app to use the Python API" consent dialog, unless the "require Automation permission" option is changed. The iTerm2 cookie/key env vars bypass this only for scripts iTerm2 itself launches.
  - The API is subscription-based: focus changes (`FocusMonitor`), session termination, variable changes (`VariableMonitor`), prompt monitor (`PromptMonitor`, which needs shell integration). That suits a daemon well.
- **[TK] iTerm2 AppleScript:**
  - `tell application "iTerm2" to create window with default profile command "..."`
  - `tell current window to create tab with default profile command "..."`
  - Session properties `tty`, `unique id`, `name`; `write text`; `select`.
  - Driving it from a background process triggers the macOS Automation (TCC) prompt.
- **[TK] Terminal.app AppleScript:**
  - Classes are `window` and `tab`. The tab has `tty`, `processes`, `busy`, `custom title`, `selected`, `current settings` (profile, and it is settable per tab), `title displays custom title`.
  - `do script "cmd"` opens a new window. `do script "cmd" in tab 1 of window 1` runs in an existing tab.
  - There is no "new tab" verb. The usual workaround is System Events `keystroke "t" using command down`, which also needs the Accessibility permission.
  - Focus a tab with `set selected of tab N of window M to true` plus `set index of window M to 1`.
  - Terminal.app supports OSC 0/1/2 and OSC 7. It does not support OSC 8 (still unsupported as of macOS 15 to my knowledge), OSC 9;4, or desktop-notification escapes.
- A daemon should prefer kitty and WezTerm for full automation, and treat Ghostty (macOS) and iTerm2 as AppleScript/Python-backed adapters. Windows Terminal is "launch + focus by index" only. Terminal.app is a minimal adapter.

### Gaps
- I did not fetch iTerm2's AppleScript or Python-API-security pages, Apple's Terminal.app scripting dictionary, or the `wezterm cli spawn`/`list` per-command pages this session. The flag details below come from training knowledge.
- I did not confirm whether `kitten @` can reach a kitty instance that was started without `listen_on` (per the docs it cannot, except from inside a kitty window).

## Q2. Open tab/window/split running a command in a directory; focus a tab; close it

### Takeaway
Every target can open a tab with a command and a working directory. Precise focus and close by id are available in kitty, WezTerm, Ghostty-AppleScript and iTerm2. Windows Terminal can focus only by tab index and cannot close a tab from outside. Terminal.app needs workarounds.

### Cited Findings
- **kitty:**
  - Open: `kitten @ launch --type=tab --tab-title "My Tab" --title ... --keep-focus`
  - Focus: `kitten @ focus-tab --match ...`, `focus-window`
  - Close: `kitten @ close-tab`, `close-window`
  - Match syntax:
    - window fields: `id`, `title`, `pid`, `cwd`, `cmdline`, `num`, `env`, `var`, `state`, `neighbor`, `session`, `recent`
    - tab fields: `id`, `index`, `title`, `window_id`, `window_title`, `pid`, `cwd`, `cmdline`, `env`, `var`, `state`, `session`, `recent`
    - boolean `and`/`or`/`not`; `state:focused`, `state:active`, `state:needs_attention`; a negative id counts from the newest
  - — [kitty remote control](https://sw.kovidgoyal.net/kitty/remote-control/)
- **WezTerm:** `wezterm cli spawn`, `split-pane`, `activate-tab`, `activate-pane`, `kill-pane`, `zoom-pane`, `move-pane-to-new-tab`. — [wezterm cli](https://wezterm.org/cli/cli/index.html)
- **Ghostty AppleScript:**
  - `new surface configuration` with fields `font size`, `initial working directory`, `command`, `initial input`, `wait after command`, `environment variables` (a list of `KEY=VALUE` strings)
  - then `new window` / `new tab` / `split` (right|left|down|up)
  - `focus`, `select tab`, `activate window`, `close`, `close tab`, `close window`
  - — [Ghostty AppleScript docs](https://ghostty.org/docs/features/applescript)
- **Ghostty Linux:** `ghostty +new-tab -e <cmd> --working-directory <dir> --title <t>` (1.4). There is no focus or close command. — [Ghostty 1.4.0 notes](https://ghostty.org/docs/install/release-notes/1-4-0)
- **Windows Terminal:**
  - Open a tab: `wt -w 0 nt -d <dir> --title <t> --tabColor #RRGGBB -p <profile> --suppressApplicationTitle <commandline>`
  - Split: `wt -w 0 sp -V|-H -s .4 -d <dir> <cmd>`
  - Focus: `wt -w 0 ft -t <index>`
  - Named windows: `wt -w agents nt ...` creates a window named "agents" if missing, and reuses it otherwise.
  - With several panes in a tab, `--tabColor` is tied to the pane, so `sp` needs its own `--tabColor`.
  - The docs list no close-tab command.
  - — [WT command line arguments](https://learn.microsoft.com/en-us/windows/terminal/command-line-arguments)
- **iTerm2 Python:** `window.async_create_tab(profile, command, index, profile_customizations)`; `session.async_activate()` then `app.async_activate()`. — [iTerm2 window API](https://iterm2.com/python-api/window.html); [iTerm2 session API](https://iterm2.com/python-api/session.html)

### Inferences
- **[TK] kitty `launch` flags:** `--cwd <dir>`, `--type=tab|window|os-window|overlay`, `--var key=val` (a user var, matchable as `var:key=val`), `--env`, `--hold`, `--location=vsplit|hsplit`. kitty can therefore tag a crosstalk agent tab at creation (`--var crosstalk_agent=<id>`) and target it later with `--match var:crosstalk_agent=<id>`.
- **[TK] WezTerm:**
  - `wezterm cli spawn --cwd <dir> [--new-window] [--workspace <name>] [--pane-id N] -- <cmd...>` prints the new pane id on stdout.
  - `wezterm cli split-pane --right|--bottom --percent N --cwd <dir> -- <cmd>`.
  - `wezterm cli activate-tab --tab-id N`, `wezterm cli kill-pane --pane-id N`.
- **[TK] iTerm2:** `session.async_close()`. With profile customizations (`LocalWriteOnlyProfile.set_initial_directory_mode`/`set_custom_directory`) a working directory can be set at creation. The `command` argument runs instead of the login shell.
- **Windows Terminal:** the tab index changes as tabs open and close, and WT gives no way to read the tab list. A daemon must keep its own index model, which is fragile. Using a distinct named window (`-w crosstalk`) for agent tabs limits the damage.

### Gaps
- WT has no documented close-tab or kill-pane from the CLI. Not confirmed whether newer previews added one.
- Terminal.app new-tab-without-keystroke: unconfirmed this session.

## Q3. Query the focused tab/pane; map tab/pane to pid/tty

### Takeaway
kitty (`ls` JSON with pid/cwd/cmdline, plus `state:focused` matching) and WezTerm (`list`/`list-clients` JSON) answer both questions. Ghostty 1.4 AppleScript has `focused terminal` and now exposes PID and TTY. iTerm2 and Terminal.app expose `tty` via AppleScript [TK]. Windows Terminal cannot answer either question.

### Cited Findings
- **kitty:** `kitten @ ls` outputs a JSON tree: OS windows, then tabs (`id`, `title`), then windows (`id`, `title`, `cwd`, `pid`, `cmdline`). Use the `state:focused` match to target the focused window. — [kitty remote control](https://sw.kovidgoyal.net/kitty/remote-control/)
- **WezTerm:** `wezterm cli list` and `list-clients` exist. Without `--pane-id`, `$WEZTERM_PANE` or the focused pane of the most recent client is used. — [wezterm cli](https://wezterm.org/cli/cli/index.html)
- **Ghostty:** `focused terminal of selected tab of front window`. Since 1.4 the terminal class exposes the foreground-process PID and the TTY. — [Ghostty AppleScript docs](https://ghostty.org/docs/features/applescript); [Ghostty 1.4.0 notes](https://ghostty.org/docs/install/release-notes/1-4-0)
- **Windows Terminal:** the CLI docs list no list or query commands. — [WT command line arguments](https://learn.microsoft.com/en-us/windows/terminal/command-line-arguments)

### Inferences
- **[TK] kitty `ls` JSON:** includes `is_focused`, `is_active` and `foreground_processes` (pid, cmdline, cwd) per window. The fetched page section did not show `is_focused`, so verify it.
- **[TK] WezTerm:**
  - `wezterm cli list --format json` gives per-pane `window_id`, `tab_id`, `pane_id`, `workspace`, `title`, `cwd` (file:// URL), `tty_name`, `is_active`, `is_zoomed`, `size`.
  - `wezterm cli list-clients --format json` gives `focused_pane_id` per client.
  - That yields an exact pane-to-tty mapping, which crosstalk can join against the agent's tty (`ps -o tty`).
- **[TK] iTerm2:**
  - Python: `app.current_terminal_window.current_tab.current_session`; `session.async_get_variable("tty")`, `"pid"`, `"jobPid"`, `"path"`.
  - Python, iTerm2 sets `ITERM_SESSION_ID=w0t1p0:<UUID>` in each shell, which a Claude Code hook inherits. That gives a stable mapping from agent process to session with no tty matching.
  - AppleScript: `tty of current session of current window`.
- **Mapping from inside the agent:** every terminal exports a pane identifier to child processes, so a Claude Code hook (running inside the agent's pane) can report it to the crosstalk daemon:
  - [TK] kitty `KITTY_WINDOW_ID`
  - WezTerm `WEZTERM_PANE` — cited in [wezterm cli](https://wezterm.org/cli/cli/index.html)
  - [TK] iTerm2 `ITERM_SESSION_ID`
  - [TK] Terminal.app `TERM_SESSION_ID`
  - [TK] Windows Terminal `WT_SESSION` (a GUID with no API to act on it)
  - [TK] Ghostty sets `GHOSTTY_RESOURCES_DIR` / `TERM_PROGRAM=ghostty` but no per-surface id, so the 1.4 AppleScript TTY property becomes the join key.
- This "hook reports its own pane id/tty" pattern is the most robust cross-terminal mapping.

### Gaps
- Exact Ghostty 1.4 AppleScript property names for PID and TTY are not in the fetched text. Check Ghostty.sdef.

## Q4. Tab title, colour, badge, background/profile, progress, user vars, status bar

### Takeaway
Tab titles via OSC 0/1/2 work everywhere. Tab colour:
- iTerm2: OSC 6 escape
- kitty: `set-tab-color`
- Windows Terminal: launch-time `--tabColor`
- WezTerm: Lua tab-bar formatting [TK]
- Ghostty 1.4: nothing (title override only)

User vars (iTerm2 `SetUserVar`, also WezTerm [TK], kitty `set-user-vars`) are the best channel for structured per-tab status that the terminal's own UI or Lua can render.

### Cited Findings
- **iTerm2 escapes:**
  - tab colour: `OSC 6;1;bg;red;brightness;N ST` (same for green and blue); reset with `OSC 6;1;bg;*;default ST`
  - user var: `OSC 1337;SetUserVar=<name>=<base64 value> ST`
  - profile: `OSC 1337;SetProfile=<name> ST`
  - colours: `OSC 1337;SetColors=<key>=<value> ST`
  - attention: `OSC 1337;RequestAttention=<value> ST`, `OSC 1337;StealFocus ST`
  - marks and cwd: `OSC 1337;SetMark ST`, `OSC 1337;CurrentDir=<dir> ST`
  - other: `OSC 1337;HighlightCursorLine=<bool> ST`, `OSC 1337;Custom=id=<secret>:<pattern> ST`
  - progress: `OSC 9;4;<st>;<pr> ST` (stop with `OSC 9;4 ST`)
  - Badges are documented separately.
  - — [iTerm2 escape codes](https://iterm2.com/documentation-escape-codes.html)
- **kitty:** `set-tab-title`, `set-tab-color`, `set-colors`, `set-background-image`, `set-font-size`, `set-user-vars`. — [kitty remote control](https://sw.kovidgoyal.net/kitty/remote-control/)
- **WezTerm escapes:**
  - OSC 0 sets icon name and window title, OSC 1 sets the tab title when non-empty, OSC 2 sets the window title.
  - OSC 6 (iTerm2 tab colour) is ignored.
  - — [WezTerm escape sequences](https://wezterm.org/escape-sequences.html)
- **WezTerm CLI:** `set-tab-title`, `set-window-title`, `rename-workspace`. — [wezterm cli](https://wezterm.org/cli/cli/index.html)
- **Ghostty:** 1.4 adds an AppleScript `name override` (read/write; empty string clears it) on tab and terminal. Alternatively `perform action "set_tab_title:Editor" on <terminal>`. 1.3 separated window/tab titles from split titles. The 1.4 notes mention no tab colour. — [Ghostty 1.4.0 notes](https://ghostty.org/docs/install/release-notes/1-4-0); [Ghostty AppleScript docs](https://ghostty.org/docs/features/applescript); [Ghostty 1.3.0 notes](https://ghostty.org/docs/install/release-notes/1-3-0)
- **Ghostty progress:** 1.3.1 added a `progress-style` setting controlling whether OSC 9;4 progress bars show. 1.3.0 parses ConEmu OSC 9 subcommands 1–12. — [Ghostty 1.3.0 notes](https://ghostty.org/docs/install/release-notes/1-3-0); [search summary of 1.3.1 notes](https://ghostty.org/docs/install/release-notes/1-3-1)
- **Windows Terminal:** `--tabColor #RGB|#RRGGBB` and `--colorScheme <name>` on `nt` and `sp` at launch. Titles from applications can be blocked with `--suppressApplicationTitle`. — [WT command line arguments](https://learn.microsoft.com/en-us/windows/terminal/command-line-arguments)
- **Windows Terminal progress:** OSC 9;4 is shown in the taskbar, per a third-party table (not Microsoft docs). — [tnotify](https://pkg.go.dev/github.com/soloterm/tnotify@v0.1.6)

### Inferences
- **[TK] WezTerm:**
  - User vars: `OSC 1337;SetUserVar=name=<base64> ST`. They are readable in Lua via `pane:get_user_vars()` and fire the `user-var-changed` event.
  - Tab bar via `wezterm.on('format-tab-title', ...)`, status via `window:set_right_status()` in `update-status`. Together these give a fully custom tab bar with per-agent colours and icons. This needs crosstalk to ship a Lua snippet the user adds to `wezterm.lua`.
  - OSC 9;4 progress is supported in recent nightlies/2024+ builds (unverified; the fetched page does not mention it).
- **[TK] kitty:** OSC 9;4 is supported since ~0.36/0.37. The tab bar can be customised via `tab_title_template` (which can reference `{tab.active_wd}`, user vars via `{custom}` and a Python `tab_bar.py`).
- **[TK] iTerm2:**
  - `SetBadgeFormat`: `OSC 1337;SetBadgeFormat=<base64 of format> ST`. The format may interpolate `\(user.varname)`.
  - Status bar components can show `\(user.xyz)` interpolated strings.
  - Python `session.async_set_variable("user.status", ...)`.
- **[TK] Terminal.app:** a per-tab profile can be changed from outside with `set current settings of tab ... to settings set "Name"`. That is the only "colour" lever.
- **[TK] Windows Terminal:** the tab colour can be changed at runtime only through the UI or a `setTabColor` action bound to a key, not from an external process. Changing the colour of an existing tab is not possible from outside.

### Gaps
- Exact OSC 9;4 support versions for WezTerm, kitty and Windows Terminal: not verified this session.

## Q5. Notifications: OSC 9 / 777 / 99 / iTerm2; does clicking focus the originating tab?

### Takeaway
For click-to-focus, OSC 99 on kitty is the only documented, default behaviour. Ghostty GTK 1.4 focuses the sender. WT's OSC 777 summons the sender window. Everything else is unconfirmed. A daemon cannot rely on terminal notifications for "jump to tab". It should post its own OS notification and on click call the terminal's focus API (kitty `focus-tab`, wezterm `activate-pane`, Ghostty/iTerm2 AppleScript, WT `ft -t`).

### Cited Findings
- **kitty OSC 99:**
  - Syntax: `OSC 99 ; key=val:key=val ; payload ST`. Both semicolons are required.
  - `i` id (reuse updates the notification)
  - `d` done flag (0 = more chunks coming)
  - `p` payload type: title|body|close|icon|?|alive|buttons
  - `a` click action: focus|report (`-` prefix disables)
  - `o` when to show: always|unfocused|invisible
  - `u` urgency 0/1/2
  - `c=1` requests a close event
  - **Clicking focuses the originating window by default.**
  - `a=report` sends an escape back carrying the `i` value.
  - kitty also supports OSC 9, and offers `kitten notify "Title" body...`.
  - — [kitty desktop notifications](https://sw.kovidgoyal.net/kitty/desktop-notifications/)
- **iTerm2:** `OSC 9 ; message ST`. The escape-code page does not mention OSC 777. — [iTerm2 escape codes](https://iterm2.com/documentation-escape-codes.html)
- **WezTerm:** OSC 9 toast (`printf "\e]9;%s\e\\" "hello"`) and OSC 777 (`printf "\e]777;notify;%s;%s\e\\" title body`; only `notify` is supported). — [WezTerm escape sequences](https://wezterm.org/escape-sequences.html)
- **Ghostty:**
  - 1.3 adds `notify-on-command-finish = never|unfocused|always` and `notify-on-command-finish-action = bell|notify`. — [Ghostty 1.3.0 notes](https://ghostty.org/docs/install/release-notes/1-3-0)
  - 1.4 fixes OSC 9/OSC 777 multibyte truncation (implying both are supported).
  - 1.4 parses OSC 99 but does not implement it.
  - On GTK, clicking a notification focuses the sending terminal; notifications are withdrawn when the terminal is focused or closed; same-text notifications replace each other.
  - — [Ghostty 1.4.0 notes](https://ghostty.org/docs/install/release-notes/1-4-0)
  - `desktop-notifications = false` blocks OSC 9/777. — third-party, [Flavio Copes](https://flaviocopes.com/ghostty/)
- **Windows Terminal:**
  - Preview v1.26.2734.0 adds OSC 777 (`OSC 777;notify;title;body`). It is off by default; enable it with `compatibility.allowOSC777` plus the `notification` bell style. — [WT v1.26.2734.0](https://github.com/microsoft/terminal/releases/tag/v1.26.2734.0)
  - The earlier PR says clicking summons the sending window, and a notification is sent only if the tab or window is inactive. — [WT PR #14425](https://github.com/microsoft/terminal/pull/14425); [issue #7718](https://github.com/microsoft/terminal/issues/7718); [PR #20012](https://github.com/microsoft/terminal/pull/20012)
  - Release year unclear on the page, and whether OSC 777 is in Stable is unconfirmed.

### Inferences
- **[TK] iTerm2:** OSC 9 notifications post via macOS Notification Center, and clicking typically brings iTerm2 to the originating session. Also `OSC 1337;RequestAttention=yes|once|no|fireworks ST` bounces the dock icon. Not verified this session.
- **[TK] Terminal.app:** no escape-code notifications. Only the bell (dock badge/bounce).
- Ghostty macOS click-to-focus behaviour is not stated in the 1.4 notes (only GTK).

### Gaps
- iTerm2 notification click behaviour and macOS Ghostty click behaviour: no sources found.
- Whether WT OSC 777 has shipped to Stable as of Nov 2026: unconfirmed.

## Q6. Cross-terminal escape layer (OSC 0/1/2, 7, 8, 9;4, 777, 133, 52, images) and herdr / OSC 7501

### Takeaway
A safe cross-terminal subset is OSC 0/2 titles, OSC 7 cwd and OSC 133 marks. OSC 8 and OSC 52 work almost everywhere except Terminal.app [TK]. OSC 9;4 progress works in iTerm2, Ghostty and WT (taskbar), plus kitty/WezTerm [TK]. OSC 7501 (Program Status Protocol, published Oct 2026) is the emerging agent-status standard. It is parsed by libghostty 1.4 but not yet surfaced in the Ghostty GUI, only Rex implements it fully, and herdr does not support it.

### Cited Findings
- **WezTerm:**
  - OSC 0/1/2 titles (1 = tab title)
  - OSC 7 cwd
  - OSC 8 hyperlinks
  - OSC 9 and OSC 777 notify
  - OSC 52 set/clear (queries ignored)
  - OSC 133 semantic zones
  - OSC 1337 File inline images
  - sixel via `DCS ... q ... ST` (preliminary)
  - OSC 6 ignored
  - — [WezTerm escape sequences](https://wezterm.org/escape-sequences.html)
- **iTerm2:**
  - FTCS marks: `OSC 133;A ST` prompt start, `B` command start, `C` executed, `D;<exit> ST` finished
  - inline images: `OSC 1337;File=[args] ST`
  - clipboard: `OSC 1337;CopyToClipboard=<name> ST` … `OSC 1337;EndCopy ST`
  - `OSC 1337;ReportCellSize ST`
  - — [iTerm2 escape codes](https://iterm2.com/documentation-escape-codes.html)
- **Ghostty:**
  - 1.3 improved OSC 133 (click-to-move-cursor `cl=line`, jump-to-prompt) and fixed kitty graphics. — [Ghostty 1.3.0 notes](https://ghostty.org/docs/install/release-notes/1-3-0)
  - 1.4 implements the kitty clipboard protocol OSC 5522; reads prompt by default, writes are capped by `clipboard-write-limit-bytes` (64 MiB). — [Ghostty 1.4.0 notes](https://ghostty.org/docs/install/release-notes/1-4-0)
  - A tip fix stopped OSC 7 shell-integration output from injecting OSC 52 via crafted directory names. — [tip changelog](https://github.com/dive/ghostty-tip-changelog/releases/tag/daily-2026-10-26)
- **OSC 7501 Program Status Protocol spec (Superlogical/Rex):**
  - Report: `ESC ] 7501 ; pairs ST`, where `pairs := key=value (":" key=value)*` and values match `[A-Za-z0-9_.,+/=-]*`. ST is `ESC \` or BEL.
  - Keys:
    - `state` (required): idle|working|done|blocked|error|clear
    - `id`: slash-hierarchical, segments `[A-Za-z0-9_.+-]{1,32}`, max 8 levels / 128 bytes
    - `kind` (with blocked): permission|question|auth
    - `progress`: 0–100, with working or blocked
    - `app`: `[A-Za-z0-9_.+-]{1,32}`, inherited from the nearest ancestor
    - `title`: base64 UTF-8, ≤192 bytes decoded
    - `msg`: base64 UTF-8, ≤2048 bytes decoded
  - Whole sequence ≤4096 bytes. Records per terminal: 256 maximum, 64 minimum required; the least recently updated record is evicted at the cap.
  - Each report fully replaces its record. `clear` without `id` clears everything. `working`/`blocked` are dropped on process exit or the next OSC 133;A. `done`/`error` persist. RIS clears all records.
  - Query `ESC ] 7501 ; ? ST`; reply `ESC ] 7501 ; ? : states=... : kinds=... ST`. Send `CSI c` after the query to detect lack of support fast.
  - — [Program Status spec](https://superlogical.com/rex/docs/build/program-status)
- **Rationale post (2026-10-06):** example `\e]7501;state=blocked:kind=permission:app=terraform:msg=<base64>\e\\`. Proof-of-concept emitters exist for Terraform, Claude Code, Codex and Homebrew. libghostty PR #14560. — [mitchellh.com](https://mitchellh.com/writing/program-status-osc7501); [PR #14560](https://github.com/ghostty-org/ghostty/pull/14560)
- **Ghostty 1.4.0:** parses OSC 7501, but "the Ghostty GUI ignores it for now". — [Ghostty 1.4.0 notes](https://ghostty.org/docs/install/release-notes/1-4-0)
- **Downstream forks:** some patch it through as `GHOSTTY_ACTION_PROGRAM_STATUS` and answer the query. — [wanggang316/ghostty PR #1](https://github.com/wanggang316/ghostty/pull/1); [promptty PR #16](https://github.com/ExManubis/promptty/pull/16)
- **herdr:**
  - Its OSC observer (`src/pane/osc.rs`, commit 4dc23bb) handles only OSC 0, 2 and 9 (titles and progress) in `AgentOscStateTracker`.
  - It does not answer `OSC 7501;?`. A raw 7501 record was dropped on herdr 0.9.3.
  - Emitters: Pi 1.1.0, Claude Code 2.1.295+ (only after a successful query reply), pi-subagents 0.77.0.
  - — [herdr discussion #5073](https://github.com/herdrdev/herdr/discussions/5073)
  - Note: the discussion's example uses ` : `-separated pairs, consistent with the spec's whitespace stripping.
  - Contradicting claim (lower reliability): a third-party post says herdr already supports it. — [dsh-TUI discussion #1406](https://github.com/ccch1mneyyy/dsh-TUI/discussions/1406)

### Inferences
- Because Claude Code emits OSC 7501 only after a terminal replies to `OSC 7501;?`, and no mainstream GUI terminal replies yet (Ghostty 1.4 parses but ignores), crosstalk cannot passively rely on CC's 7501 output today. Two options:
  - (a) Derive state from CC hooks itself.
  - (b) If crosstalk wraps the agent in a PTY (as herdr does), answer the query itself and consume the records.
- **[TK] OSC 8:** supported by iTerm2, kitty, WezTerm, Ghostty, Windows Terminal (1.4+) and VS Code. Not supported by Terminal.app.
- **[TK] OSC 52:** iTerm2 (opt-in setting), kitty, WezTerm, Ghostty and WT write support. Not Terminal.app.
- **[TK] Images:**
  - kitty graphics protocol: kitty, Ghostty, WezTerm (partial).
  - iTerm2 OSC 1337 File: iTerm2, WezTerm, VS Code (when enabled).
  - sixel: WezTerm, Windows Terminal 1.22+, VS Code (with `terminal.integrated.enableImages`), iTerm2. Not kitty or Ghostty.
- **[TK] OSC 133:** iTerm2, kitty, WezTerm, Ghostty, WT (marks/scrollbar, 1.21+) and VS Code (alongside its own OSC 633).

### Gaps
- Exact current OSC 9;4 / OSC 8 / sixel support versions for kitty, WezTerm and WT were not fetched.
- The superlogical spec did not list implementers other than Rex.

## Q7. Can an external process write escape codes to another tab's tty and have them take effect?

### Takeaway
Yes, mechanically. Writing bytes to the pty slave (`/dev/ttysNNN`, `/dev/pts/N`) that the shell or agent owns sends them to the terminal emulator as output, so OSC titles, tab colour, user vars and notifications take effect. The caveats are interleaving with the agent's own output (a TUI like Claude Code can be corrupted mid-frame) and the need for the same uid. kitty `send-text` and WezTerm `send-text` instead write to the pty input (keystrokes), which is a different thing.

### Cited Findings
- kitty `send-text`/`send-key` and WezTerm `send-text` inject *input*. Ghostty `input text`/`send key` do the same. — [kitty remote control](https://sw.kovidgoyal.net/kitty/remote-control/); [wezterm cli](https://wezterm.org/cli/cli/index.html); [Ghostty AppleScript](https://ghostty.org/docs/features/applescript)
- Ghostty 1.4 exposes each terminal's TTY via AppleScript, so a daemon can discover which tty to write to. — [Ghostty 1.4.0 notes](https://ghostty.org/docs/install/release-notes/1-4-0)

### Inferences
- [TK] Standard Unix pty semantics: a write to the slave device goes to the master, which is the terminal emulator, and is interpreted as output. This works for all macOS/Linux terminals here. Windows Terminal (ConPTY) has no tty device file, so the approach does not work there, except inside WSL ptys.
- Risk: escapes written in the middle of a CC TUI redraw can split its sequences. Short, atomic `write()` calls of a complete OSC (≤4 KB, one syscall) are usually safe in practice.
- Prefer the terminal API where it exists (kitty `set-tab-title`/`set-user-vars`, WezTerm `set-tab-title`, Ghostty `name override`). Fall back to tty writes for iTerm2 (SetUserVar/badge/tab colour have no simpler external path besides the Python API) and Terminal.app titles.

### Gaps
- No primary source fetched on tty-write behaviour per terminal. This is generic Unix knowledge.

## Q8. Layouts/workspaces, sessions; runtime theme/font changes

### Takeaway
kitty (sessions + `set-colors`/`set-font-size`) and WezTerm (workspaces + Lua) support both layouts and runtime theming from outside. iTerm2 has Arrangements and per-session colour changes. Ghostty has per-surface font size at creation, and theme changes only via config reload. WT can pick a colour scheme only at launch.

### Cited Findings
- **kitty:** `set-colors`, `set-background-image`, `set-font-size` over remote control. Match fields include `session`. — [kitty remote control](https://sw.kovidgoyal.net/kitty/remote-control/)
- **WezTerm:** `rename-workspace`. — [wezterm cli](https://wezterm.org/cli/cli/index.html)
- **iTerm2:** `OSC 1337;SetProfile=<name> ST` and `OSC 1337;SetColors=<key>=<value> ST` per session. — [iTerm2 escape codes](https://iterm2.com/documentation-escape-codes.html)
- **Ghostty:** the surface configuration's `font size` applies at creation. Key tables were added in 1.3. — [Ghostty AppleScript](https://ghostty.org/docs/features/applescript); [Ghostty 1.3.0 notes](https://ghostty.org/docs/install/release-notes/1-3-0)
- **WT:** `--colorScheme <name>` per tab or pane at creation. — [WT command line arguments](https://learn.microsoft.com/en-us/windows/terminal/command-line-arguments)

### Inferences
- **[TK] kitty sessions:** a session file (`kitty --session file`, plus a newer `goto_session` action in 2025+) declares `new_tab`, `cd`, `launch`, `layout`. `kitten @ set-colors --match ... colors.conf` changes a single window's palette.
- **[TK] WezTerm:**
  - `wezterm cli spawn --workspace <name>`
  - Lua `window:set_config_overrides{}` for runtime per-window theme and font
  - `wezterm.mux` for scripted layouts
- **[TK] iTerm2:** Window Arrangements, saved and restored via Python `async_save_window_arrangement`/`async_restore`.
- **[TK] Ghostty:** OSC 10/11/4 palette escapes are honoured per surface. That is a per-tab theme path via tty write.

### Gaps
- None of the session or arrangement docs were fetched this session.

## Q9. Permissions and prompts

### Takeaway
macOS AppleScript control (Ghostty, iTerm2, Terminal.app) triggers a TCC Automation prompt for the calling binary, the first time per target app. iTerm2's Python API has its own consent. kitty needs `allow_remote_control` + `listen_on` in the user's config. WezTerm needs nothing. WT needs nothing, but OSC 777 is opt-in.

### Cited Findings
- **Ghostty:** macOS Automation (TCC) prompts before another app can control it. `macos-applescript = false` disables scripting. — [Ghostty AppleScript](https://ghostty.org/docs/features/applescript)
- **kitty:** `allow_remote_control`, `listen_on`, `remote_control_password`, `is_cmd_allowed`. — [kitty remote control](https://sw.kovidgoyal.net/kitty/remote-control/)
- **WT:** OSC 777 needs `compatibility.allowOSC777` plus the `notification` bell style. — [WT v1.26.2734.0](https://github.com/microsoft/terminal/releases/tag/v1.26.2734.0)
- **Ghostty clipboard:** OSC 52/5522 reads prompt by default (`clipboard-read`). — [Ghostty 1.4.0 notes](https://ghostty.org/docs/install/release-notes/1-4-0)

### Inferences
- [TK] On macOS, TCC attributes the request to the "responsible process". For a daemon launched from a Claude Code hook inside a terminal, the prompt names that terminal app (for example "iTerm2 wants to control Ghostty"). That can be confusing. A launchd-started daemon gets its own entry.
- [TK] iTerm2: Settings > General > Magic > Enable Python API, plus a per-script consent dialog for externally launched scripts.
- [TK] WezTerm: the CLI socket is per-user with no prompt.

### Gaps
- Exact iTerm2 Python API consent wording and settings: not fetched.

## Q10. VS Code integrated terminal (short note)

### Takeaway
VS Code has no external CLI to drive its terminals. Control is through an extension (`vscode.window.createTerminal`, `terminal.show()`, `onDidChangeActiveTerminal`, `Terminal.processId`, `sendText`). It honours OSC 0/2 titles, OSC 8, OSC 133/633 shell integration and images (opt-in). All of this is [TK] and was not fetched.

### Cited Findings
- I fetched no primary VS Code source this session. A third-party article describes enabling Claude Code notifications in both Ghostty and VS Code on macOS. — [zenn.dev](https://zenn.dev/ryok/articles/claude-code-notification-ghostty-vscode?locale=en)

### Inferences
- [TK] For crosstalk, VS Code support means shipping a small companion extension that talks to the daemon over a socket, or else treating VS Code as a launch-only target (`code --new-window`) with no tab control.

### Gaps
- VS Code OSC 9/777 notification and OSC 9;4 support: unverified.

---

### Summary matrix (C = cited this session, TK = training knowledge, unverified)

| Capability | iTerm2 | kitty | WezTerm | Ghostty 1.4 | Terminal.app | Windows Terminal |
|---|---|---|---|---|---|---|
| External control | Python API + AppleScript (TK; Python calls C) | `kitten @ --to unix:` (C) | `wezterm cli` (C) | AppleScript, macOS only (C); Linux `+new-tab` only (C) | AppleScript (TK) | `wt.exe -w` launch-only (C) |
| New tab + cmd + cwd | yes (C/TK) | `launch --type=tab --cwd` (C/TK) | `spawn --cwd` (TK) | surface config (C) | `do script` new window; tab via keystroke (TK) | `nt -d` (C) |
| Focus specific tab | yes (C) | `focus-tab --match` (C) | `activate-tab/pane` (C) | `focus`/`select tab` (C) | `selected` (TK) | `ft -t index` (C) |
| Close | yes (TK) | `close-tab` (C) | `kill-pane` (C) | `close tab` (C) | yes (TK) | no (C: undocumented) |
| Query focused / pid / tty | yes (TK) | `ls` JSON pid/cwd (C) | `list`/`list-clients` (C; fields TK) | focused terminal + PID/TTY (C) | `tty` (TK) | no (C) |
| Tab colour | OSC 6 (C) | `set-tab-color` (C) | Lua only (TK); OSC 6 ignored (C) | none (C) | profile only (TK) | launch `--tabColor` (C) |
| User vars | SetUserVar (C) | `set-user-vars` (C) | SetUserVar (TK) | no | no | no |
| OSC 9;4 progress | yes (C) | TK | TK | yes, `progress-style` (C) | no (TK) | taskbar (C, 3rd-party) |
| Notifications | OSC 9 (C) | OSC 99 + 9 (C) | OSC 9 + 777 (C) | OSC 9/777 (C); 99 parsed only | none (TK) | OSC 777 opt-in, preview (C) |
| Click focuses origin | TK | yes, default (C) | unknown | GTK yes (C); macOS unknown | n/a | summons window (C, PR) |
| OSC 7501 | no evidence | no evidence | no evidence | parsed, GUI ignores (C) | no | no |
