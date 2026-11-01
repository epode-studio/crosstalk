# tmux as a programmable multi-agent workspace (scriptable by an external daemon)

Scope: what a same-user daemon can do to tmux's look and interaction through the `tmux` CLI and control mode, with exact syntax. As of 2026-11-01.

Sources used most: the tmux CHANGES file and `tmux.1` on master (pulled 2026-10-30), the 3.8 tag's `tmux.1`, and tmux C source (`input.c`, `tty-features.c`, `cmd-display-menu.c`). Release tag dates were read from the tag commits. Several items were also tested in this session on a local **tmux 3.4** server (marked "verified locally").

Version timeline (dates from tag commits): 3.4 = 2024-02-13, 3.5 = 2024-09-27, 3.5a = 2024-10-05, 3.6 = 2025-11-26, 3.6a = 2025-12-05, 3.7 = 2026-06-26, 3.7c = 2026-07-23, **3.8 = 2026-10-08 (latest release)** — [tmux repo tags / CHANGES](https://github.com/tmux/tmux/blob/master/CHANGES)

---

## 1. Look: names, titles, per-window styles, status bar, colours

### Takeaway
An external process can set everything the user sees from outside: window names, pane titles, per-window user options (`@foo`), formats with conditionals, up to 5 status lines, and pane border lines. The common pattern is that the daemon writes state into a **window or pane user option** (`set -w -t @ID @agent_state waiting`), and the static formats in the config render it through `#{?…}` conditionals. This needs no `#()` shell polling, and a redraw can be forced with `refresh-client -S`.

### Cited Findings
**Names and titles**
- `rename-window -t <target> <name>` sets a name explicitly, and doing so turns off `automatic-rename` for that window. `allow-rename on|off` controls whether programs in the pane may rename the window with `\ek…\e\\`. `allow-set-title on|off` (added in 3.5) controls whether programs may change the pane title with `\e]2;…\e\\` or `\e]0;…`. — [tmux.1](https://github.com/tmux/tmux/blob/master/tmux.1); [CHANGES 3.4→3.5](https://github.com/tmux/tmux/blob/master/CHANGES)
- `set-titles on` plus `set-titles-string <format>` sets the outer terminal's title (formats are expanded). Use it to put e.g. `#{session_name}:#{window_name} #{@agent_state}` in the host terminal tab. — [tmux.1](https://github.com/tmux/tmux/blob/master/tmux.1)
- 3.7 sanitizes pane titles and window/session names more strictly (C0 and invisible characters). 3.7a forbids only `#(` in names and allows `#[`, empty names, `:` and `.`. — [CHANGES 3.6b→3.7, 3.7→3.7a](https://github.com/tmux/tmux/blob/master/CHANGES)
- 3.8 adds `new-pane`/`split-window -T <title>` to set the pane title at creation, and a default `C-b T` binding to retitle a pane. — [CHANGES 3.7c→3.8](https://github.com/tmux/tmux/blob/master/CHANGES)

**User options and conditionals (verified locally on 3.4)**
- User options start with `@` and can be set at server, session, window or pane scope:
  - `tmux set -w -t repoA:agent1 @agent_state waiting`
  - `tmux set -p -t %3 @agent_session_id abc123`
  - read back with `tmux show -wv -t @1 @agent_state` or `display -p '#{@agent_state}'`.

  Locally, this conditional expanded to `#[fg=magenta]? agent1`:
  `#{?#{==:#{@agent_state},waiting},#[fg=magenta]? ,#{?#{==:#{@agent_state},working},#[fg=yellow]* ,}}#W`
  — verified locally (tmux 3.4); [tmux.1 FORMATS](https://github.com/tmux/tmux/blob/master/tmux.1)
- The window loop `#{W:…}` iterates over windows, e.g. `display -p '#{W:#{window_name}=#{@agent_state} }'` printed `agent1=waiting agent2=working`. Related loops are `#{S:…}` (sessions) and `#{P:…}` (panes). `#{L:…}` (clients) was added in 3.4, and 3.6 added sorting to W/P/L. — verified locally; [CHANGES 3.3a→3.4, 3.5a→3.6](https://github.com/tmux/tmux/blob/master/CHANGES)
- 3.6 extends conditionals:
  - `#{?cond1,a,cond2,b,c}` (else-if); an omitted else is the empty string.
  - `&&` and `||` accept many arguments, and `!` / `!!` are available.
  - Numeric comparisons have existed since 3.2.

  — [CHANGES](https://github.com/tmux/tmux/blob/master/CHANGES)
- 3.8 adds format modifiers: `O:` loops over options, `V:` over environment, `I` gives client terminal info, `t/d` a time difference in seconds, `c/f` and `c/b` emit colours, `m` takes multiple terms and fuzzy matching, and `#{A/count:frames}` animates frames in the status line (useful for a "working" spinner without `#()`). New variables include `pane_last_output_time` and `pane_output_generation`. — [CHANGES 3.7c→3.8](https://github.com/tmux/tmux/blob/master/CHANGES)
- `E:` expands a format twice (since 2.9). The man page uses it to extend a default status line instead of replacing it:
  ```
  set -g status 2
  set -gu status-format
  set -gF @old_status_format1 "#{status-format[1]}"
  set -g status-format[1] "#{E:@old_status_format1}#[nolist align=right]#{pane_current_path}"
  ```
  — [tmux.1](https://github.com/tmux/tmux/blob/master/tmux.1)

**Per-window and per-pane style options**
- Window list in the status bar:
  - `window-status-format` and `window-status-current-format` (formats);
  - `window-status-style`, `window-status-current-style`;
  - alert styles: `window-status-activity-style`, `window-status-bell-style`.

  — [tmux.1](https://github.com/tmux/tmux/blob/master/tmux.1)
- Pane appearance:
  - `window-style` / `window-active-style` (the pane background). Note that master's man entry for `window-style` reads "Set the pane style".
  - `pane-border-style` and `pane-active-border-style`.
  - `pane-border-lines` (`single|double|heavy|rounded|simple|number|spaces`; `spaces` added in 3.6).
  - `pane-border-indicators off|colour|arrows|both`.
  - `pane-border-status off|top|bottom`; 3.8 adds `top-floating|bottom-floating`.
  - `pane-border-format <format>`, which became a **pane** option in 3.3 so each pane can have its own label.

  — [tmux.1](https://github.com/tmux/tmux/blob/master/tmux.1); [CHANGES](https://github.com/tmux/tmux/blob/master/CHANGES)
- Master (after 3.8, not released) adds `window-pane-status-format` / `window-pane-current-status-format` for the per-window pane list in the status line. — [tmux.1 master](https://github.com/tmux/tmux/blob/master/tmux.1)
- Workmux's documented status format, a good real-world template:
  ```
  set -g window-status-format '#I:#W#{?@workmux_status, #{@workmux_status},}#{?window_flags,#{window_flags}, }'
  set -g window-status-current-format '#I:#W#{?@workmux_status, #{@workmux_status},}#{?window_flags,#{window_flags}, }'
  ```
  Its icons are 🤖 working / 💬 waiting / ✅ done ("auto-clears on window focus"), and icons may contain style codes such as `#[fg=#a6e3a1]󰄴#[fg=default]`. — [workmux status tracking](https://workmux.dev/guide/status-tracking/)

**Status line**
- `status off|on|2|3|4|5` and `status-format[0..4]`.
  - 3.6 added nicer default 2nd and 3rd lines.
  - From 3.7 the default 2nd line lists the current window's panes, and the man page says the 3rd lists sessions.
  - `status-interval` defaults to 15 s; `0` disables timed redraws.
  - `status-justify left|centre|right|absolute-centre`.

  — [tmux.1](https://github.com/tmux/tmux/blob/master/tmux.1); [CHANGES 3.6, 3.7](https://github.com/tmux/tmux/blob/master/CHANGES)
- `refresh-client -S` redraws only the status line, so a daemon can update `@` options and then call `tmux refresh-client -S -t <client>` (or loop over `list-clients -F '#{client_name}'`). — [tmux.1 refresh-client](https://github.com/tmux/tmux/blob/master/tmux.1)
- `#(shell cmd)` in status formats runs through `/bin/sh` (3.5a reverted to `/bin/sh` for `#()`, run-shell and if-shell). It refreshes at `status-interval`, and nested job expansion has been disabled since 3.2. For a daemon, pushing values into `@` options is cheaper and more immediate than `#()` polling. — [CHANGES 3.5→3.5a, 3.1c→3.2](https://github.com/tmux/tmux/blob/master/CHANGES)
- 3.7 draws messages as one format with a new `message-format` option. Messages and prompts can cover part of the status bar, and `message-style` must contain `fill=` to cover the full width. — [CHANGES 3.6b→3.7](https://github.com/tmux/tmux/blob/master/CHANGES)
- **Side status line (master only, not in 3.8):**
  - `side-status off|left|right`, `side-status-format`, `side-status-style`, `side-status-width`.
  - The format can produce multiple rows (`nl` style or newline), and rows with `list=on` scroll to keep `list=focus` visible.
  - Mouse keys `SideStatus*`.

  This is effectively a built-in vertical sidebar for an agent list. Checked: the 3.8 tag's `tmux.1` has 0 mentions. — [tmux.1 master](https://github.com/tmux/tmux/blob/master/tmux.1)

**Colour**
- RGB/true colour since 2.2, enabled by the terminfo `Tc` or (since 2.7) `RGB` capability, or with the terminal feature:
  `set -as terminal-features ',xterm-256color:RGB'`
  The feature names include `RGB`, `hyperlinks`, `sixel`, `sync`, `progressbar`, `usstyle`, `osc7`, `extkeys`, `focus`.
  3.6 sets and checks `COLORTERM` as an RGB hint. 3.8 lets you disable a feature by writing `@feature`.
  — [tmux.1 terminal-features](https://github.com/tmux/tmux/blob/master/tmux.1); [CHANGES](https://github.com/tmux/tmux/blob/master/CHANGES)
- 3.8 themes:
  - built-in light/dark palettes for 256+ colour terminals;
  - a `theme` option (detect / terminal / force light or dark; set `terminal` for the old colours);
  - theme colour names such as `themegreen`;
  - colours in styles are expanded as formats, so `fg=#{@agent_colour}` works;
  - hooks `client-light-theme` / `client-dark-theme` and the format `client_theme`.

  — [CHANGES 3.7c→3.8](https://github.com/tmux/tmux/blob/master/CHANGES); [tmux.1](https://github.com/tmux/tmux/blob/master/tmux.1)
- 3.8 style attributes: `dim=` and `link=<url>` / `nolink` (styled text becomes an OSC 8 hyperlink), so **status-line text can be a clickable hyperlink**. — [CHANGES 3.7c→3.8](https://github.com/tmux/tmux/blob/master/CHANGES); [tmux.1 STYLES](https://github.com/tmux/tmux/blob/master/tmux.1)

### Inferences
- A good design: the daemon owns the `@agent_*` options on each window and pane, and a static `tmux.conf` snippet (installed by the plugin) renders them. Each state change is then `set -w` plus `refresh-client -S`, with no polling.
- Set `automatic-rename off` and `allow-rename off` on agent windows so neither Claude Code's own title escapes nor the shell overwrite daemon-chosen names. Keep `allow-set-title on` if the pane title (`#T`) should still reflect Claude Code's own title.

### Gaps
- Exact defaults of `status-format[1]` and `[2]` in 3.8 were not captured verbatim.
- No release date is known for the side status line feature.

---

## 2. Interaction: popups, menus, pickers, prompts, keys, mouse, clickable status, hooks, alerts

### Takeaway
tmux has every UI primitive an agent switcher needs:
- modal popups running any TUI (`display-popup -E`);
- right-click-style menus (`display-menu`);
- filtered tree pickers (`choose-tree -f`);
- prompts (`command-prompt`);
- custom key tables;
- clickable status ranges (`#[range=user|X]`, then `MouseDown1Status` reading `#{mouse_status_range}`);
- hooks for focus, window change and alerts.

3.7 and 3.8 add floating and modal panes and a richer event/monitor hook system.

### Cited Findings
**display-popup (since 3.2; most flags since 3.3)**
- Synopsis (3.8): `display-popup [-BCEkN] [-b border-lines] [-c target-client] [-d start-directory] [-e environment] [-h height] [-s style] [-S border-style] [-t target-pane] [-T title] [-w width] [-x position] [-y position] [shell-command [argument ...]]` (alias `popup`).
  - `-E` closes when the command exits; `-EE` closes only on success.
  - `-k` lets any key dismiss after exit (3.6).
  - `-w`/`-h` accept `%`; the default size is half the terminal.
  - `-B` draws no border; `-b` sets the border line type.
  - `-s`/`-S` set the popup and border styles; `-T` sets a title; `-e VAR=val` sets environment.
  - Run inside an existing popup, it modifies that popup (3.6).

  — [tmux.1 at 3.8](https://github.com/tmux/tmux/blob/3.8/tmux.1); [cmd-display-menu.c](https://github.com/tmux/tmux/blob/master/cmd-display-menu.c); [CHANGES](https://github.com/tmux/tmux/blob/master/CHANGES)
- Option defaults: `popup-style`, `popup-border-style`, `popup-border-lines`.
  - Since 3.3 a right-click on the popup border opens a menu to close, fill, centre, or "turn into a pane".
  - Popups no longer freeze pane output (3.3), and OSC 52 works in popups (3.7).

  — [CHANGES](https://github.com/tmux/tmux/blob/master/CHANGES)
- Example pattern (craftzdog tmux-claude-hatch, needs tmux ≥ 3.2): each Claude Code session runs in its own *nested* tmux session prefixed `claude-`, shown in a 90%×90% popup bound to `prefix y`. `prefix d` closes the popup and leaves the session running. — [tmux-claude-hatch](https://github.com/craftzdog/tmux-claude-session-manager)

**Floating and modal panes (3.7 / 3.8)**
- `new-pane` (alias `newp`, default key `*`) creates a **non-modal floating pane** that behaves like a real pane (full escape-sequence support).
  - Synopsis (master): `new-pane [-AbCDdEfhIkKLMOPvWZ] [-B border-lines] [-c dir] [-e env] [-F format] [-l size] [-m message] [-p pct] [-R inactive-border-style] [-s style] [-S active-border-style] [-t target-pane] [-T title] [-x width] [-y height] [-X x] [-Y y] [cmd ...]`.
  - The default size is half the window width and a quarter of its height.

  — [tmux.1 master](https://github.com/tmux/tmux/blob/master/tmux.1)
- 3.8 flags:
  - `-O` **modal pane**: one per window, it blocks the other panes.
  - `-C` closes on a click outside; `-K` sends all keys, including the prefix, to the pane; `-D` closes on Esc or C-c.
  - `-A` stays above a zoomed pane; `-W` waits for the command to exit.
  - `move-pane`/`resize-pane` work on floating panes; `break-pane` can float a tiled pane and `join-pane` can tile it again.
  - `choose-tree -h` hides the pane containing the mode, and `-k` kills the pane when the mode exits.
  - `command-prompt -P` opens a prompt inside a pane.

  — [CHANGES 3.7c→3.8](https://github.com/tmux/tmux/blob/master/CHANGES)
- 3.8 also adds:
  - `switch-mode`, a fast window/session switcher bound to `Tab` (windows) and `S-Tab` (sessions), styled by `switch-mode-match-style`;
  - `remain-on-exit failed-key`;
  - `new-window -E` for an empty pane;
  - `capture-pane -I` (timestamps per line);
  - menus now "belong to the window, so appear on all clients".

  — [CHANGES 3.7c→3.8](https://github.com/tmux/tmux/blob/master/CHANGES)

**display-menu, choose-tree, command-prompt, display-message**
- `display-menu [-OM] [-b border-lines] [-c target-client] [-C starting-choice] [-H selected-style] [-s style] [-S border-style] [-t target-pane] [-T title] [-x position] [-y position] name key command [name key command ...]`.
  - An empty name gives a separator.
  - `-M` forces mouse handling (3.5); `-O` keeps the menu open on mouse release.
  - `-x`/`-y` accept formats, e.g. `-x M -y S` or `popup_*`/`menu_*` variables such as `popup_centre_x`.

  — [tmux.1](https://github.com/tmux/tmux/blob/master/tmux.1); [CHANGES](https://github.com/tmux/tmux/blob/master/CHANGES)
- `choose-tree [-GhikNrswyZ] [-F format] [-f filter] [-K key-format] [-O sort-order] [-t target-pane] [template]`.
  - `-f` is a format filter, e.g. `-f '#{==:#{@agent_state},waiting}'` shows only agents awaiting input.
  - `-F` sets the line format, `-K` the shortcut keys (3.2), `-s`/`-w` start collapsed, `-Z` zooms.
  - The list commands also take `-f` (3.2) and `-O` sort (3.7).

  — [tmux.1](https://github.com/tmux/tmux/blob/master/tmux.1); [CHANGES](https://github.com/tmux/tmux/blob/master/CHANGES)
- `command-prompt [-1bCeFiklNP] [-I inputs] [-p prompts] [-t target-client] [-T prompt-type] [template]`.
  - `%%` / `%1` substitute the input.
  - 3.8 changed escaping so `%%` is safe inside single quotes while `%1` stays unquoted.

  — [tmux.1](https://github.com/tmux/tmux/blob/master/tmux.1); [CHANGES 3.8](https://github.com/tmux/tmux/blob/master/CHANGES)
- `display-message [-aCIjlNpv] [-c target-client] [-d delay] [-t target-pane] message`.
  - `-d 0` waits for a key; `-N` ignores keys until the delay ends; `-C` keeps panes updating.
  - `-p` prints to stdout; `-l` prints literally; `-j` parses JSON; `-a` lists all format variables.
  - 3.4 made it work for control clients.

  — [tmux.1](https://github.com/tmux/tmux/blob/master/tmux.1)

**Keys, key tables, mouse, clickable status**
- `bind-key -T <table> <key> <cmd>` and `switch-client -T <table>` give modal key tables. `send-keys -K` (3.4) processes keys as if typed. 3.8 turns `mouse` **on by default**. — [tmux.1](https://github.com/tmux/tmux/blob/master/tmux.1); [CHANGES](https://github.com/tmux/tmux/blob/master/CHANGES)
- Mouse key names are `<Event><Location>`:
  - events: `MouseDown1-3`, `MouseUp1-3`, `MouseDrag1-3`, `MouseDragEnd1-3`, `WheelUp/Down`, `SecondClick`, `DoubleClick`, `TripleClick`;
  - locations: `Pane`, `Border`, `Status`, `StatusLeft`, `StatusRight`, `StatusDefault`, `ScrollbarSlider/Up/Down`, `Empty`, `ControlN` (3.7), and `SideStatus*` (master).

  `{mouse}` or `=` as a target resolves to the window or pane under the mouse. — [tmux.1 MOUSE SUPPORT](https://github.com/tmux/tmux/blob/master/tmux.1)
- Status ranges:
  - `#[range=left]`, `#[range=right]`, `#[range=window|X]` (2.9+);
  - `#[range=session|X]`, `#[range=pane|X]`, `#[range=user|X]` (3.4), where user X is at most 15 bytes;
  - `#[range=control|N]` with N 0-9 (3.7), triggering a `ControlN` key;
  - `#[norange]` ends a range.

  The click sets `mouse_status_range` (to `session`/`window`/`pane` or the user X) and `mouse_status_line`. — [tmux.1 STYLES](https://github.com/tmux/tmux/blob/master/tmux.1); [CHANGES 3.3a→3.4, 3.7](https://github.com/tmux/tmux/blob/master/CHANGES)
- Working pattern; the status format part was accepted on 3.4 (verified locally):
  ```
  set -g status 2
  set -g status-format[1] '#[align=left]#{W:#[range=window|#{window_index}]#{window_name}:#{@agent_state}#[norange] }#[range=user|newagent] [+new] #[norange]'
  bind -n MouseDown1Status if -F '#{==:#{mouse_status_range},newagent}' 'run-shell "crosstalk new-agent"' 'switch-client -t ='
  ```
  The binding follows the man page's documented semantics; the `if -F` dispatch was not click-tested. — verified locally (format only); [tmux.1](https://github.com/tmux/tmux/blob/master/tmux.1)

**Hooks** (`set-hook [-agpRuw] [-B name:what:format] [-t target] hook command`; array hooks with `hook[n]`)
- `after-<command>` hooks exist for most commands (e.g. `after-select-window`, `after-split-window`), plus `command-error` (3.5). The non-command hooks are:
  - alerts: `alert-activity`, `alert-bell`, `alert-silence`;
  - clients: `client-active` (3.3), `client-attached`, `client-closed`, `client-created`, `client-detached`, `client-focus-in`, `client-focus-out`, `client-resized`, `client-session-changed`, `client-light-theme`, `client-dark-theme`;
  - `marked-pane-changed`;
  - panes: `pane-activity`, `pane-bell`, `pane-command-started`, `pane-command-finished`, `pane-shell-prompt` (OSC 133, 3.8), `pane-created`, `pane-died`, `pane-exited`, `pane-focus-in`, `pane-focus-out` (needs `focus-events on`), `pane-mode-changed`, `pane-mode-entered`, `pane-mode-exited`, `pane-moved`, `pane-prompt-opened`, `pane-prompt-closed`, `pane-resized`, `pane-set-clipboard`, `pane-title-changed`;
  - sessions: `session-created`, `session-closed`, `session-renamed`, `session-window-changed`, `session-added-to-group`, `session-removed-from-group`;
  - windows: `window-created`, `window-closed`, `window-layout-changed`, `window-linked`, `window-unlinked`, `window-pane-changed`, `window-renamed`, `window-resized`, `window-zoomed`, `window-unzoomed`.

  Many of these are new in 3.8. — [tmux.1 HOOKS](https://github.com/tmux/tmux/blob/master/tmux.1); [CHANGES 3.8](https://github.com/tmux/tmux/blob/master/CHANGES)
- **3.8 monitor hooks**:
  - `set-hook -B '@name:what:format' [command]` re-checks a format every second and fires when it changes; with `-T`, only when it becomes true. The name must start with `@`, and monitor hooks are not inherited.
  - `set-hook -E @event` fires a user event.
  - `wait-for -E <event> [-F format] [-v]` blocks until a hook, notification or user event fires; `-v` prints the payload keys.

  Example: `set-hook -g -B '@waiting:@*:#{==:#{@agent_state},waiting}' -T 'display -d 0 "agent needs input"'`. — [tmux.1](https://github.com/tmux/tmux/blob/master/tmux.1); [CHANGES 3.8](https://github.com/tmux/tmux/blob/master/CHANGES)
- `wait-for [-L|-S|-U] channel` (since 1.8) is a simple cross-process lock or signal, e.g. a hook runs `tmux wait-for -S agent-ready` and a script blocks on `tmux wait-for agent-ready`. — [tmux.1](https://github.com/tmux/tmux/blob/master/tmux.1); [CHANGES 1.7→1.8](https://github.com/tmux/tmux/blob/master/CHANGES)

**Alerts**
- `monitor-activity on|off`, `monitor-bell on|off` and `monitor-silence <seconds>` are window options. Related options:
  - `activity-action`, `bell-action`, `silence-action` take `any|none|current|other`;
  - `visual-activity`, `visual-bell`, `visual-silence` take `on|off|both`.

  Flags for formats: `window_activity_flag`, `window_bell_flag`, `window_silence_flag`, `session_alerts`. — [tmux.1](https://github.com/tmux/tmux/blob/master/tmux.1)
- The craftzdog plugin's trick: Claude Code is told to write a real BEL (`"preferredNotifChannel": "terminal_bell"`, `"messageIdleNotifThresholdMs": 0`), and a Stop/Notification hook writes `\a` to the pane tty. It resolves the tty with `tmux display-message -p -t "$TMUX_PANE" '#{pane_tty}'`, so tmux's bell monitoring highlights the window. — [tmux-claude-hatch](https://github.com/craftzdog/tmux-claude-session-manager)

### Inferences
- A daemon can raise an alert without the agent's cooperation by writing `\a` to the agent pane's `#{pane_tty}`, or simply by setting `@agent_state` and letting the format colour the window. The `@` option route is more precise (it separates "waiting" from "done").
- On 3.8+, `new-pane -O -C -D 'crosstalk picker'` (a modal floating pane) is a better launcher/switcher host than `display-popup`, because floating panes support full escape sequences and can be moved, resized and tiled.

### Gaps
- Not checked: whether `display-menu` items can carry style per item beyond `-H` / `menu-style`.
- The `MouseDown1Status` plus `if -F` dispatch was not click-tested; only the format was validated.

---

## 3. Programmatic control and finding "what the user is looking at"

### Takeaway
Use IDs (`$session`, `@window`, `%pane`) and `-F` formats. A pane can be mapped to a Claude Code process through `#{pane_pid}` (the first process, usually the shell or `claude` itself) or `#{pane_tty}`, combined with a process-tree walk. The window/pane each client is viewing can be read with `list-clients -F` or `window_active_clients`. Control mode (`tmux -C attach -f no-output,ignore-size`) gives an event stream without polling, including **format subscriptions** (`refresh-client -B`).

### Cited Findings
**Creating and targeting**
- `new-window [-abdEkPS] [-c start-directory] [-e environment] [-F format] [-n window-name] [-t target-window] [shell-command [argument ...]]`. With `-P -F '#{window_id} #{pane_id}'` it prints the new IDs. `new-session -d -s name -c dir [cmd]` with `-A` attaches if the session exists (`-c` works with `-A` since 3.7). — [tmux.1](https://github.com/tmux/tmux/blob/master/tmux.1); [CHANGES 3.7](https://github.com/tmux/tmux/blob/master/CHANGES)
- A command can be given as several argv words that are exec'd without `sh -c`, e.g. `tmux new-window vi ~/.tmux.conf`. This applies to new-window, new-session, split-window, respawn-* and display-popup. — [tmux.1](https://github.com/tmux/tmux/blob/master/tmux.1)
- 3.7 adds `{current}` / `{active}` as `-t` targets. — [CHANGES 3.6b→3.7](https://github.com/tmux/tmux/blob/master/CHANGES)
- `claude-squad` uses plain CLI calls:
  - `new-session -d -s claudesquad_<name> -c <workDir> <program>`
  - `set-option -t <name> history-limit 10000`
  - `set-option -t <name> mouse on`
  - `has-session -t=<name>`
  - `capture-pane -p -e -J -t <name>`, SHA-256-hashed to detect output changes
  - `kill-session`

  It detects prompts by matching screen text, e.g. Claude `"No, and tell Claude what to do differently"` and the trust prompt `"Do you trust the files in this folder?"`, which it auto-answers with Enter. — [claude-squad tmux.go](https://raw.githubusercontent.com/smtg-ai/claude-squad/main/session/tmux/tmux.go)

**Process and session mapping (verified locally)**
- `list-panes -a -F '#{pane_id} #{pane_pid} #{pane_tty} #{pane_current_command} #{pane_current_path}'` printed e.g. `%0 1753 /dev/pts/0 sleep /home/user/crosstalk`. Other useful variables:
  - `pane_start_command`, `pane_start_command_list` (3.8), `pane_start_path`;
  - `pane_dead`, `pane_dead_status`, `pane_title`, `pane_in_mode`, `pane_last_output_time` (3.8).

  — verified locally; [tmux.1](https://github.com/tmux/tmux/blob/master/tmux.1)
- Inside a pane, `$TMUX_PANE` holds the pane ID, so a Claude Code hook can report `$TMUX_PANE` with its session id, as craftzdog's hook does. — [tmux-claude-hatch](https://github.com/craftzdog/tmux-claude-session-manager)
- Claude Code's own agent-teams split-pane mode stores "session IDs and tmux pane IDs" in `~/.claude/teams/{team}/config.json` and uses tmux or iTerm2 (`teammateMode: "auto"|"tmux"|"iterm2"|"in-process"`). Split panes are not supported in VS Code's terminal, Windows Terminal or Ghostty, and the docs suggest `tmux -CC` in iTerm2. — [Claude Code agent teams docs](https://code.claude.com/docs/en/agent-teams)

**Who is looking at what**
- `list-clients [-r] [-F format] [-f filter] [-O sort] [-t session]` with variables:
  - `client_name`, `client_tty`, `client_pid`, `client_session`, `client_flags`;
  - `client_activity`, `client_termname`, `client_termtype`, `client_termfeatures`;
  - `client_width`, `client_height`, `client_key_table`, `client_prefix`, `client_readonly`, `client_theme`, `client_uid`, `client_user`, `client_last_session`.

  `client_flags` has included `focused` since 3.2, i.e. the terminal reports focus. The `active-pane` client flag was removed in 3.8. — [tmux.1](https://github.com/tmux/tmux/blob/master/tmux.1); [CHANGES](https://github.com/tmux/tmux/blob/master/CHANGES)
- Per window: `window_active`, `window_active_clients`, `window_active_clients_list`, `window_active_sessions`, `window_active_sessions_list`. Per session: `session_attached`, `session_attached_list`. Recipe: `tmux list-clients -F '#{client_tty} #{client_flags} #{session_name} #{window_id} #{pane_id}'`, where the window/pane fields are those of the client's current session. — [tmux.1](https://github.com/tmux/tmux/blob/master/tmux.1)
- Focus-driven events: the `client-focus-in`/`out` and `pane-focus-in`/`out` hooks need `focus-events on`, and the client must be re-attached after changing it. `after-select-window`, `session-window-changed` and `client-session-changed` catch navigation. — [tmux.1](https://github.com/tmux/tmux/blob/master/tmux.1)

**Control mode**
- `-C` keeps the tty in canonical mode (for testing); `-CC` turns echo off and wraps the stream in `\033P1000p` … `%exit` + ST for terminals such as iTerm2. An empty line detaches. Each command reply is framed `%begin <time> <num> <flags>` … `%end` or `%error`. — [tmux wiki Control Mode](https://github.com/tmux/tmux/wiki/Control-Mode); [tmux.1](https://github.com/tmux/tmux/blob/master/tmux.1)
- Notifications:
  - `%client-detached`, `%client-session-changed`, `%config-error` (3.4), `%continue`, `%exit`, `%extended-output`;
  - `%layout-change window-id layout visible-layout flags`, `%message`, `%output %pane value` (octal-escaped below ASCII 32 and backslash), `%pane-mode-changed`;
  - `%paste-buffer-changed`, `%paste-buffer-deleted`, `%pause`;
  - `%session-changed`, `%session-renamed`, `%session-window-changed`, `%sessions-changed`;
  - `%subscription-changed name $s @w idx %p ... : value`;
  - `%unlinked-window-add`, `%unlinked-window-close`, `%unlinked-window-renamed`;
  - `%window-add`, `%window-close`, `%window-pane-changed`, `%window-renamed`.

  — [tmux.1 CONTROL MODE](https://github.com/tmux/tmux/blob/master/tmux.1)
- Client flags (`attach -f`, `refresh-client -f`): `ignore-size`, `new-layouts` (3.8 JSON layouts), `no-detach-on-destroy`, `no-output`, `pause-after=N`, `read-only`, `wait-exit`, with `!flag` to clear. Control clients do not affect window size unless given `refresh-client -C WxH`. — [tmux.1](https://github.com/tmux/tmux/blob/master/tmux.1); [wiki](https://github.com/tmux/tmux/wiki/Control-Mode)
- **Verified locally on 3.4**, a daemon event stream with no output flood:
  ```
  tmux -C attach -t repoA -f no-output,ignore-size
  refresh-client -B 'st:@*:#{window_name}=#{@agent_state}'
  ```
  This produced `%subscription-changed st $0 @0 0 - : agent1=waiting` and, after an external `set -w @agent_state done`, `… : agent1=done` within about 1 s. A `rename-window` produced `%window-renamed @1 agentX`.

  The format argument **must be quoted**: unquoted `#{…}` gave `parse error: syntax error`, since `#` starts a comment in command parsing. Subscriptions report at most once per second. — verified locally; [tmux.1 refresh-client -B](https://github.com/tmux/tmux/blob/master/tmux.1)
- 3.8 hardens control mode: bounded reply buffering, notifications queued outside `%begin`/`%end`, a stuck client no longer blocks server exit, and offsets reset on respawn. Clients keep the old layout strings unless they set `new-layouts`. — [CHANGES 3.8](https://github.com/tmux/tmux/blob/master/CHANGES)

### Inferences
- The recommended daemon architecture:
  1. one long-lived `tmux -C attach -f no-output,ignore-size` per session, or per server via a hidden session, for events and subscriptions;
  2. one-shot `tmux …` CLI calls for mutations;
  3. Claude Code hooks that report `$TMUX_PANE` and `session_id` to the daemon, giving an exact pane↔session map without pid-walking.

  A control client attaches to one session, so notifications such as `%window-add` cover that session. `%sessions-changed` plus `@*`/`%*` subscriptions handle the rest. With several workspaces this may need one control client per session (not tested).
- `pane_pid` is the first process. If agents are launched as `new-window … claude …` it is Claude Code's pid. If they are started from a shell, walk children (`pgrep -P`).

### Gaps
- Not verified: whether a control client created with `new-session -d`-like semantics can avoid being "attached" in `session_attached` counts. It will appear in `list-clients` with a `control-mode` flag (assumption, unverified).

---

## 4. Escape-code passthrough: what reaches the outer terminal

### Takeaway
tmux interprets most modern sequences itself and re-emits them when the outer terminal supports the feature:
- OSC 8 hyperlinks (3.4);
- OSC 52 clipboard;
- OSC 133 prompt marks (3.4; events in 3.8);
- OSC 9;4 progress (3.7, stored in formats and forwarded);
- SIXEL (3.4, compile-time);
- synchronized output 2026 (3.7);
- theme 2031 (3.6);
- extended keys (3.2, revamped 3.5);
- focus 1004.

**Plain OSC 9 / OSC 777 / OSC 99 desktop notifications are not handled.** tmux drops them unless they are wrapped in DCS passthrough. Kitty graphics and OSC 9;9 are on master only.

### Cited Findings
- tmux's OSC dispatcher handles only 0, 2, 4, 7, 8, 9, 10, 11, 12, 52, 104, 110, 111, 112 and 133, and logs others as "unknown". Within OSC 9 it handles only `9;4` (progress) and, on master, `9;9` (cwd), so a plain `OSC 9;<message>` notification is dropped. OSC 777 and OSC 99 hit the "unknown" default. — [input.c](https://github.com/tmux/tmux/blob/master/input.c)
- `allow-passthrough on|off|all` (a pane option, added in 3.3, default off; `all` since 3.4 also works for invisible panes). Wrap a sequence as `\ePtmux;` + payload with every ESC doubled + `\e\\`. Example:
  `printf '\ePtmux;\e\e]9;Agent needs input\a\e\\'`.
  The man page gives the form `(\ePtmux;...\e\\)`. `on` passes only when the pane is visible. — [tmux.1](https://github.com/tmux/tmux/blob/master/tmux.1); [CHANGES 3.2a→3.3, 3.3a→3.4](https://github.com/tmux/tmux/blob/master/CHANGES)
- OSC 8 hyperlinks since 3.4. They need the `hyperlinks` terminal feature (kitty has it by default in tmux's table; otherwise `set -as terminal-features '*:hyperlinks'`). Also `mouse_hyperlink`, `copy_cursor_hyperlink`, and `capture-pane` options for capturing hyperlinks. — [CHANGES 3.3a→3.4, 3.5](https://github.com/tmux/tmux/blob/master/CHANGES); [tty-features.c](https://github.com/tmux/tmux/blob/master/tty-features.c); [tmux.1](https://github.com/tmux/tmux/blob/master/tmux.1)
- OSC 52:
  - `set-clipboard on|external|off` (on: accept and forward to the terminal; external: forward only tmux's own copies);
  - 3.4 passes through which clipboard the application requested;
  - 3.6 detects OSC 52 support via Device Attributes;
  - 3.7 adds `get-clipboard` (off by default) to forward clipboard *reads*.

  — [tmux.1](https://github.com/tmux/tmux/blob/master/tmux.1); [CHANGES](https://github.com/tmux/tmux/blob/master/CHANGES)
- OSC 9;4 progress (3.7) is stored in `pane_pb_state` (hidden, normal, error, indeterminate, paused) and `pane_pb_progress`. It is forwarded to the outer terminal when that has the `progressbar` feature (terminfo `Spb=\E]9;4;%p1%d;%p2%d\E\\`). This means **Claude Code's OSC 9;4 progress can be read from formats**, e.g. `#{?#{==:#{pane_pb_state},indeterminate},⟳,}`. — [CHANGES 3.6b→3.7](https://github.com/tmux/tmux/blob/master/CHANGES); [tmux.1](https://github.com/tmux/tmux/blob/master/tmux.1); [tty-features.c](https://github.com/tmux/tmux/blob/master/tty-features.c)
- OSC 133:
  - 3.4 marks prompts, and `next-prompt`/`previous-prompt` (with `-o` for output) navigate them;
  - 3.8 fires `pane-command-started`, `pane-command-finished` and `pane-shell-prompt` hooks.

  — [CHANGES](https://github.com/tmux/tmux/blob/master/CHANGES)
- OSC 7 sets `pane_path` (3.1) and the `osc7` terminal feature (3.3). — [CHANGES](https://github.com/tmux/tmux/blob/master/CHANGES)
- Images:
  - SIXEL since 3.4, only when built with `--enable-sixel`; `sixel_support` format (3.6, always 0 on OpenBSD);
  - images are saved and restored in the alternate screen (3.6); up to 20 SIXEL images (3.7).
  - Master renames the configure flag to `--enable-images` (`--enable-sixel` is an alias) and adds a **kitty graphics (APC `G…`) parser** (`image-kitty.c`). This is absent from the 3.8 tag.

  — [CHANGES](https://github.com/tmux/tmux/blob/master/CHANGES); [configure.ac / input.c master](https://github.com/tmux/tmux/blob/master/input.c)
- Keys and focus:
  - `extended-keys on|off|always` (3.2; `always` in 3.2a); since 3.5 tmux always requests mode 2 from the outer terminal, and `extended-keys-format csi-u|xterm` controls the output format;
  - `focus-events on` forwards focus and fires focus hooks;
  - DECSET 2026 synchronized output from applications (3.7);
  - mode 2031 theme reports (3.6).

  — [CHANGES](https://github.com/tmux/tmux/blob/master/CHANGES); [tmux.1](https://github.com/tmux/tmux/blob/master/tmux.1)

### Inferences
- For desktop notifications from agents in tmux, crosstalk has three options:
  1. have the daemon emit the notification itself, e.g. by writing OSC 9/777 to the *client* tty (`#{client_tty}` from list-clients);
  2. use DCS passthrough with `allow-passthrough on`;
  3. rely on BEL plus the terminal's own bell→notification behaviour.

  Writing to `client_tty` directly bypasses tmux and could corrupt the display if it interleaves with a redraw. It is probably safe for a single short OSC (untested).

### Gaps
- No primary source was found on whether tmux forwards OSC 9;4 when the outer terminal is not detected as supporting it. The `progressbar` feature may need adding manually (`terminal-features '*:progressbar'`).

---

## 5. Layouts, persistence, workspaces

### Takeaway
Layouts can be read and restored as strings: `#{window_layout}`, then `select-layout '<string>'`. 3.8 moves to a JSON-subset layout format that includes floating panes and still accepts the old format. Persistence across server restarts is not built in (resurrect-style plugins rebuild sessions from saved metadata). "Workspace per repo" maps naturally to one tmux session per repo with one window per agent.

### Cited Findings
- `select-layout` takes `even-horizontal|even-vertical|main-horizontal|main-vertical|tiled` or a saved layout string. 3.5 added mirrored `main-horizontal-mirrored` / `main-vertical-mirrored`, and 3.6 added `tiled-layout-max-columns`. — [tmux.1](https://github.com/tmux/tmux/blob/master/tmux.1); [CHANGES 3.4→3.5, 3.6](https://github.com/tmux/tmux/blob/master/CHANGES)
- 3.8: "Layout strings now use a JSON subset format which includes floating panes. The old format is still accepted; control mode clients receive old layouts unless they set the new-layouts flag." The man example shows `[layout {"V":2,"L":{"t":"p","w":80,"h":24,...,"I":"%2"}}]`. — [CHANGES 3.8](https://github.com/tmux/tmux/blob/master/CHANGES); [tmux.1](https://github.com/tmux/tmux/blob/master/tmux.1)
- Session lifecycle options: `destroy-unattached off|on|keep-last|keep-group` (the keep-* values arrived in 3.4) and `detach-on-destroy` (`no-detached` fixed in 3.6). The 3.6 client flag `no-detach-on-destroy`. — [tmux.1](https://github.com/tmux/tmux/blob/master/tmux.1); [CHANGES](https://github.com/tmux/tmux/blob/master/CHANGES)
- 3.4 can spawn panes in separate systemd cgroups. 3.7 works around systemd killing panes early at shutdown. — [CHANGES](https://github.com/tmux/tmux/blob/master/CHANGES)
- 3.8 `clear-on-attach` (server option): when disabled, tmux scrolls the existing terminal content into scrollback instead of entering the alternate screen. — [CHANGES 3.8](https://github.com/tmux/tmux/blob/master/CHANGES)
- Agent tools that run their own private tmux server:
  - agent-manager puts each agent in its own tmux session on a private server named `agentmgr` (`tmux -L agentmgr`), so agents survive the manager UI exiting; latest listed v0.14.2.
  - claude-squad uses `claudesquad_*` sessions on the default server.

  — [agent-manager pkg.go.dev](https://pkg.go.dev/github.com/YoanWai/agent-manager@v0.14.2); [claude-squad tmux.go](https://raw.githubusercontent.com/smtg-ai/claude-squad/main/session/tmux/tmux.go)

### Inferences
- For crosstalk the user's *own* tmux server (default socket) should host the agent windows, so they sit beside the user's work. A private `-L` socket fits only if crosstalk wants an isolated "agent workspace" the user attaches to explicitly.
- The daemon can persist its own metadata (repo, worktree, Claude session id per `@window`) and rebuild after a reboot with `new-session -A`, `new-window -c`, `claude --resume <id>`, and `select-layout <saved>`. That is the resurrect approach, but agent-aware.

### Gaps
- READMEs for tmux-resurrect/continuum, tmuxinator, sesh and tmux-fzf were not fetched in this session, so their specific mechanics are not cited here.

---

## 6. Remote: SSH, nested tmux, other machines

### Takeaway
tmux runs fine over SSH (`ssh -t host tmux new -A -s agents`). Nested tmux works but needs a different prefix or key-table toggles. `tmux -CC` over SSH in iTerm2 maps remote windows to native tabs. Control mode is a text protocol on stdin/stdout, so a daemon can drive a remote tmux with `ssh host tmux -C attach …`.

### Cited Findings
- `tmux -CC` emits DCS `\033P1000p` so terminals such as iTerm2 detect control mode. Claude Code docs recommend `tmux -CC` in iTerm2 as the entry point for agent-team split panes. — [tmux wiki Control Mode](https://github.com/tmux/tmux/wiki/Control-Mode); [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams)
- The terminal-features table includes a `tmux` entry, so nested tmux gets extkeys, focus, overline and similar features. — [tty-features.c](https://github.com/tmux/tmux/blob/master/tty-features.c)
- tmux-agent-status monitors remote hosts with `setup-server.sh <session-name> <ssh-host>`. — [tmux-agent-status](https://github.com/samleeney/tmux-agent-status)
- 3.8 lets server ACLs (`server-access`) use groups as well as users. — [CHANGES 3.8](https://github.com/tmux/tmux/blob/master/CHANGES)

### Inferences
- Remote agent support for crosstalk: run the daemon (or a thin agent) on the remote host, talking to the remote tmux. Alternatively, have the local daemon hold `ssh host tmux -C attach -f no-output,ignore-size` for events, which is plain text over SSH.
- For OSC passthrough when nested, ESCs must be doubled once per tmux layer, and `allow-passthrough` must be on at each layer.

### Gaps
- No primary source was fetched on nested-tmux prefix conventions or SSH agent forwarding inside tmux (`update-environment` covers `SSH_AUTH_SOCK`; WAYLAND_DISPLAY was added in 3.7).

---

## 7. Notable tmux-based agent dashboards and their tricks

### Takeaway
Existing tools fall into three patterns:
1. **a TUI manager owning tmux sessions** (claude-squad, agent-manager);
2. **tmux plugins rendering agent state in the status bar, a sidebar pane or a popup picker** (tmux-agent-status, tmux-claude-hatch, workmux);
3. **Claude Code's built-in tmux split-pane teams**.

Status detection has moved from screen-scraping (claude-squad) to **Claude Code hooks writing state files or tmux options** (tmux-agent-status, workmux, craftzdog, agent-manager).

### Cited Findings
- **claude-squad** (smtg-ai):
  - a `cs` TUI with keys `n`/`N` new, `↵`/`o` attach, `ctrl-q` detach, `D` kill, `s` commit+push, `c` checkout/pause, `r` resume;
  - git worktree per session;
  - needs tmux and gh;
  - status by hashing `capture-pane -p -e -J` and matching prompt strings;
  - attach runs `attach-session` inside a PTY and intercepts byte 17 (Ctrl-Q) to detach.

  — [README](https://github.com/smtg-ai/claude-squad); [tmux.go](https://raw.githubusercontent.com/smtg-ai/claude-squad/main/session/tmux/tmux.go)
- **tmux-agent-status** (samleeney):
  - Claude Code hooks (`UserPromptSubmit`, `PreToolUse`, `Stop`, `Notification`) write `~/.cache/tmux-agent-status/<session>.status` (`working|done|wait`), or per pane `panes/<session>_<pane>.status`;
  - a collector daemon updates `status-right` with one glyph per agent (✳ Claude, ⬢ Codex), coloured by state (working yellow and pulsing, waiting cyan, ask magenta, done green);
  - an auto-created sidebar pane in every session, an fzf switcher popup, an unread "completion inbox", parking, notification sounds, remote hosts, and worktree deploys.

  — [tmux-agent-status](https://github.com/samleeney/tmux-agent-status)
- **tmux-claude-hatch** (craftzdog, tmux ≥ 3.2):
  - a popup per project directory hosting a nested `claude-*` tmux session;
  - an fzf+jq picker (`prefix u`) with live previews, reading status from Claude Code's session files (falling back to `claude agents`, Claude Code ≥ 2.1.139);
  - BEL forwarding through `#{pane_tty}` to light up windows.

  — [tmux-claude-hatch](https://github.com/craftzdog/tmux-claude-session-manager)
- **workmux** (raine):
  - git worktree + tmux window per task, with backends tmux, kitty, WezTerm or Zellij;
  - a Claude Code plugin `workmux-status` runs `workmux set-window-status working|done`, which sets the `@workmux_status` window option;
  - it auto-edits `window-status-format`, and the ✅ icon auto-clears on window focus;
  - a popup dashboard and a sidebar.

  — [workmux guide](https://workmux.dev/guide/status-tracking/); [repo](https://github.com/raine/workmux)
- **agent-manager** (YoanWai): a TUI for Claude Code, Codex, OpenCode, Grok and Gemini CLI. Each agent runs in its own session on the private `agentmgr` server, and Claude Code hook events feed status files. — [pkg.go.dev](https://pkg.go.dev/github.com/YoanWai/agent-manager@v0.14.2)
- **Claude Code agent teams**: `teammateMode` `in-process|auto|tmux|iterm2` (experimental, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). Each teammate gets a tmux split pane, and orphaned sessions can be cleaned with `tmux kill-session`. — [Claude Code docs](https://code.claude.com/docs/en/agent-teams)

### Inferences
- The workmux pattern (hook → `set -w @status` → format) is the leanest and needs no collector polling. crosstalk's daemon can do the same with richer states (working/waiting-question/permission/done/error) and add clickable ranges and `choose-tree -f` filters on those options.
- The "auto-clear done on focus" trick needs either an `after-select-window` / `session-window-changed` hook (e.g. `set-hook -g session-window-changed 'run -b "crosstalk seen #{window_id}"'`) or the daemon watching `%session-window-changed` in control mode.

### Gaps
- Not researched: herdr.dev and Paradev internals, sesh, tmuxinator, tmux-fzf, and other 2025-26 tools (e.g. "ntm", "agent-deck"); the searches returned nothing primary for them.

---

## 8. Version requirements and what distros ship (late 2026)

### Takeaway
A reasonable floor is **3.2** (popups, `-f` filters, focus hooks, subscriptions, extended keys). For OSC 8, `range=user` and L-loops, **3.4** is the practical floor; for OSC 9;4 progress formats it is **3.7**; for floating/modal panes, monitor hooks, `wait-for -E`, themes, `link=` styles and animation it is **3.8**. Ubuntu 24.04 LTS (3.4) and Debian 13 (3.5a) are the important laggards; Homebrew, Arch, Fedora updates, MacPorts and Tumbleweed are on 3.8.

### Cited Findings
Shipped versions:

| Distro | tmux version |
|---|---|
| Homebrew | 3.8 |
| MacPorts | 3.8 |
| Arch | 3.8 |
| openSUSE Tumbleweed | 3.8 |
| Fedora 44 | 3.6a release, 3.8 in updates |
| nixpkgs | unstable 3.8; 26.05 stable 3.7b |
| Alpine | 3.24: 3.7c; edge: 3.8 |
| Debian | 13 trixie: 3.5a; testing (forky): 3.7c |
| Ubuntu | 24.04: 3.4; 25.10: 3.5a; 26.04: 3.6a |
| AlmaLinux | 9: 3.2a |

RHEL 10 / AlmaLinux 10 were not listed. — [Repology](https://repology.org/project/tmux/versions)

Feature → minimum version, from [CHANGES](https://github.com/tmux/tmux/blob/master/CHANGES) unless noted:

| Version | Features |
|---|---|
| 2.2 / 2.7 | RGB via `Tc` / `RGB` |
| 2.9 | `status-format[]`, multi-line status, `range=window`, `E:` |
| 3.0 | `display-menu` |
| 3.2 | `display-popup`; `-f` filters on list commands; `pane-focus-in/out`; control-mode subscriptions (`refresh-client -B`); `pause-after`; extended keys; `client_flags` `focused`; numeric comparisons |
| 3.3 | `allow-passthrough`; popup `-B -b -s -S -T`, `-e`; `client-active` hook; per-pane `pane-border-format`; `c` (RGB) modifier; OSC 7 feature |
| 3.4 | OSC 8; SIXEL (build flag); `range=session/pane/user`, `mouse_status_range`; `L:` loop; `list-clients -f`; `allow-passthrough all`; OSC 133; `send-keys -K`; `%config-error`; `display-message` for control clients |
| 3.5 | extended keys mode 2 / `extended-keys-format`; `command-error` hook; `allow-set-title`; `display-menu -M` |
| 3.6 | `display-popup -k`; else-if and multi-arg boolean formats; 2031 theme reporting; sorting in loops; scrollbars; `pane-border-lines spaces`; default 2nd/3rd status lines |
| 3.7 | floating panes (`new-pane`); OSC 9;4 progress + `pane_pb_*`; control ranges `range=control\|N`; `{current}`/`{active}` targets; `focus-follows-mouse`; `message-format`; synchronized output; `get-clipboard`; run-shell `#{1}` args |
| 3.8 | modal/floating improvements; JSON layouts; monitor hooks `set-hook -B/-E/-T`; `wait-for -E`; many new hooks; OSC 133 events; `switch-mode`; themes; `link=`/`dim=` styles; `A/` animation; `pane_last_output_time`; `mouse on` by default; `clear-on-attach` |
| master only (unreleased) | side status line (`side-status*`, master `tmux.1`); kitty graphics parser and OSC 9;9 (master `input.c` vs 3.8 tag) |

### Inferences
- crosstalk should feature-detect at runtime (`tmux -V`, or `display -p '#{version}'`) and degrade:
  - **≥ 3.8**: modal pane picker, monitor hooks, theme colours;
  - **3.4–3.7**: `display-popup`, `range=user`, `@` options;
  - **3.2–3.3**: no user ranges, so use window ranges and key bindings only;
  - **< 3.2**: no popups.

### Gaps
- Tag-commit dates were used as release dates; GitHub release publication dates may differ by a day or so (the GitHub API was not reachable from this session).
