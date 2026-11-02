# Claude Code UI and interaction extension points for a plugin (as of Nov 2026, Claude Code 2.1.31x)

Evidence labels used throughout:
- **[DOC]**: stated in the official docs at code.claude.com.
- **[TYPES]**: stated in the engine-written mod API declaration file of the locally installed Claude Code **2.1.316** (`/tmp/claude-0/bundled-skills/2.1.316/104f091ba2eeb98476ffacc7b2bfe61e/plugin-authoring/types/claude-code.d.ts`, 22,942 lines, header "EARLY ACCESS: this surface may change between releases without notice"), or in the `reference.md` beside it. This is first-party, build-specific text, not a public doc page, but it is more precise than the docs.
- **[ISSUE]**: reported in GitHub issues or third-party write-ups; not confirmed by Anthropic.
- **[LOCAL]**: observed on this machine (Claude Code 2.1.316, Linux cloud container) or in the crosstalk repo's own spikes.
- **[SPIKE]**: unknown; needs a test.

**The main finding up front:** since v2.1.287 (terminal) and v2.1.286 (Desktop), Claude Code has **mods**, a documented in-process plugin API: a plugin's `hooks/hooks.json` names a JS/TS "hooks module". Mods can draw **panes, a band above the prompt, toasts, a per-plugin status line, dim transcript notices**, ask the user questions in the native dialog, and intercept incoming cross-session or channel deliveries (`session.receive` → `{consumed}`) so **the model never sees them**. That covers crosstalk's main need, which the older settings-hook / statusline / MCP surfaces cannot fully meet. Details are in section 4.

---

## 1. Statusline: config, stdin JSON, refresh, multi-line, colours, OSC 8, plugin shipping

### Takeaway
The classic `statusLine` is a shell command. It gets session JSON on stdin and prints rows (multi-line, ANSI colours, OSC 8 links all supported). It runs on events, debounced at 300 ms, and can also run on a timer through `refreshInterval` (minimum 1 s). **A plugin cannot ship the main `statusLine`**: plugin `settings.json` only applies `agent` and `subagentStatusLine`. A mod can instead pin its own line with `$.ui.status(text)`.

### Cited Findings
- [DOC] Config shape: `{"statusLine": {"type": "command", "command": "...", "padding": 2, "refreshInterval": N, "hideVimModeIndicator": true}}`. `padding` is extra horizontal spacing (default 0). `refreshInterval` re-runs the command every N seconds on top of event-driven updates, with a minimum of `1`. `hideVimModeIndicator` hides the built-in `-- INSERT --` — [Statusline docs](https://code.claude.com/docs/en/statusline)
- [DOC] Triggers: once at session start or resume, then on each new assistant message, when `/compact` finishes, on a permission-mode change, on a vim-mode toggle, when the `command` changes, on the `refreshInterval` tick, and when a rate-limit `resets_at` or a prompt-cache `expires_at` passes. "Claude Code debounces updates at 300ms… If a new update triggers while your script is still running, Claude Code cancels the in-flight script." The event triggers "can go quiet when the main session is idle"; use `refreshInterval` to cover that — [Statusline docs](https://code.claude.com/docs/en/statusline)
- [DOC] Output: "each `echo` or `print` statement displays as a separate row" (multi-line). ANSI colour escapes are supported. OSC 8 hyperlinks are supported in terminals that have them (iTerm2, Kitty, WezTerm). The script can't read the terminal size itself, so Claude Code sets `COLUMNS` and `LINES`. It "temporarily hides during certain UI interactions, including the help menu and permission prompts". It stays blank until workspace trust is accepted. A non-zero exit or empty output also blanks it. `disableAllHooks` disables it — [Statusline docs](https://code.claude.com/docs/en/statusline)
- [DOC] It renders in its own row above the footer badges. With a custom status line, most footer hints (`esc to interrupt`, `? for shortcuts`) are hidden — [Statusline docs](https://code.claude.com/docs/en/statusline)
- [DOC] stdin JSON fields:
  - `cwd`, `workspace.{current_dir, project_dir, added_dirs, git_worktree, repo.{host,owner,name}}`, `model`
  - `cost`, `context_window.{total_input_tokens,total_output_tokens,context_window_size,used_percentage,remaining_percentage,current_usage}`, `exceeds_200k_tokens`
  - `effort.level`, `rate_limits.{five_hour,seven_day,spend_limit}.*`, `prompt_cache` (v2.1.251+)
  - `session_id`, `session_name` (the `/rename`/`--name` name or the AI title), `transcript_path`, `version`
  - `vim.mode`, `agent.name`, `pr.{number,url,kind,review_state}`, `worktree.{name,path,branch,original_cwd,original_branch}`
  
  Several are optional or absent until the first API response — [Statusline docs](https://code.claude.com/docs/en/statusline)
- [DOC] `subagentStatusLine` renders a custom row for each subagent in the agent panel. It runs "once per refresh tick" with the base hook fields, `columns` and a `tasks` array. "Plugins can ship a default `subagentStatusLine` in their `settings.json`" — [Statusline docs](https://code.claude.com/docs/en/statusline)
- [DOC] Plugin `settings` / root `settings.json`: "Only `agent` and `subagentStatusLine` take effect; other keys are dropped at load." — [Plugin manifest reference](https://code.claude.com/docs/en/plugins-reference)
- [TYPES] Mod alternative: `$.ui.status(text)` "Pins `text` as this plugin's status line under the prompt, beside the engine's own pinned notices… One per plugin; `undefined` removes it." The terminal draws the first 2,000 chars; it can be called from any hook or timer (`$.clock.every`) — local `claude-code.d.ts` 2.1.316 (`/tmp/claude-0/bundled-skills/2.1.316/104f091ba2eeb98476ffacc7b2bfe61e/plugin-authoring/types/claude-code.d.ts`)

### Inferences
- crosstalk can't install the user's main statusline from the plugin. It can (a) give users a script to add themselves, (b) ship a `subagentStatusLine`, or (c) use a mod `$.ui.status` line, which updates on demand from a timer with no shell process and no 300 ms debounce.
- The statusline never enters model context (it runs locally and uses no tokens), so it is a safe display channel. It can't take input.

### Gaps
- Whether a `$.ui.status` line can carry ANSI colour or OSC 8 links is not stated (the types say "text"). [SPIKE]
- The docs give no maximum row count for a multi-line statusline. [SPIKE]

---

## 2. Settings hooks: events, output fields, and who sees what

### Takeaway
There are 33 hook events in 2.1.31x. The visibility rule:
- **`systemMessage`** is shown to the user only (as a warning or notice) for synchronous hooks. Several events discard it, and for **async hooks it goes to Claude, not the user**.
- **`additionalContext`** goes to the model only.
- **UserPromptSubmit `decision:"block"`** keeps the prompt from Claude. The `reason` is shown to the user and is **not** added to context. The prompt still lands in the on-disk transcript and history.
- `suppressOutput` does nothing.

### Cited Findings
- [DOC] Event list: SessionStart, Setup, UserPromptSubmit, UserPromptExpansion, PreToolUse, PermissionRequest, PermissionDenied, PostToolUse, PostToolUseFailure, PostToolBatch, Notification, MessageDisplay, SubagentStart, SubagentStop, TaskCreated, TaskCompleted, Stop, StopFailure, TeammateIdle, InstructionsLoaded, ConfigChange, CwdChanged, DirectoryAdded, FileChanged, WorktreeCreate, WorktreeRemove, PreCompact, PostCompact, PreModelSwitch, PostModelSwitch, Elicitation, ElicitationResult, SessionEnd — [Hooks reference](https://code.claude.com/docs/en/hooks). The same 33 names appear as `hook_event_name` literals in [TYPES] 2.1.316.
- [DOC] Common output fields (verbatim):
  - `continue` (default true): "If `false`, Claude stops processing entirely… Takes precedence over any event-specific decision fields"
  - `stopReason`: "Message shown to the user when `continue` is `false`. It stays in the conversation, so Claude sees it if the conversation continues"
  - `suppressOutput`: "Has no effect… A successful hook's stdout is never shown in the transcript and is recorded in the debug log"
  - `systemMessage`: "Warning message shown to the user. In Agent SDK and `--output-format stream-json` output, it can arrive as an `SDKInformationalMessage`"
  - `terminalSequence`: see section 3
  
  — [Hooks reference](https://code.claude.com/docs/en/hooks)
- [DOC] Where `systemMessage` goes, by event:
  - Discarded by Setup, InstructionsLoaded, Notification, MessageDisplay, ConfigChange, WorktreeCreate, WorktreeRemove, PreCompact, PostCompact, SessionEnd, Elicitation and ElicitationResult.
  - CwdChanged and FileChanged show it "as a brief terminal notification", and it "doesn't reach the SDK message stream".
  - DirectoryAdded (`slash_command` source) "delivers the hook's `systemMessage` to Claude as context on the next conversation turn, rather than showing it to you".
  - PreModelSwitch shows it to the user regardless of the decision.
  
  — [Hooks reference](https://code.claude.com/docs/en/hooks)
- [DOC] **Async hooks** (`"async": true`): "Claude Code delivers the `additionalContext` and `systemMessage` fields… to Claude on the next conversation turn… Unlike a synchronous hook's `systemMessage`, neither field is shown to you." `asyncRewake: true` "wakes Claude on exit code 2"; the stderr is shown to Claude as a system reminder — [Hooks reference](https://code.claude.com/docs/en/hooks)
- [DOC] **UserPromptSubmit** output:
  - `decision: "block"` "stops the prompt before it reaches Claude".
  - `reason` is "Shown to the user when `decision` is `"block"`. Not added to context".
  - `additionalContext` is a "String added to Claude's context alongside the submitted prompt".
  - `sessionTitle` "Sets the session title".
  - `suppressOriginalPrompt: true` "leaves the prompt text out of the block message".
  - By default "the block message shown to the user ends with `Original prompt:` followed by the submitted text, and Claude Code writes that message to the session's transcript file on disk… The submitted text can still appear in local files such as the session transcript and your prompt history."
  - UserPromptSubmit "can't replace the prompt; it only injects `additionalContext`."
  
  Example: `{"decision":"block","reason":"…","hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"…","sessionTitle":"…","suppressOriginalPrompt":true}}` — [Hooks reference](https://code.claude.com/docs/en/hooks)
- [DOC] Plain stdout on exit 0 becomes model context only for UserPromptSubmit, UserPromptExpansion, SessionStart and PostModelSwitch. For every other event it goes to the debug log. "Claude never sees stderr from a hook that exits 0." — [Hooks reference](https://code.claude.com/docs/en/hooks)
- [DOC] Exit code 2:
  - **Stderr goes to Claude** for PreToolUse (as the tool error), UserPromptSubmit (blocks), Stop, SubagentStop and TeammateIdle (keeps the turn going), TaskCreated, TaskCompleted, PostToolUse and PostToolUseFailure.
  - **User only** for SessionStart, SubagentStart, SessionEnd, CwdChanged, FileChanged, PostCompact and PostModelSwitch ("a `<hook name> hook error` notice and Claude doesn't see it").
  - **Ignored** for Notification, Setup, InstructionsLoaded, StopFailure, PermissionDenied, DirectoryAdded, MessageDisplay and PermissionRequest.
  
  — [Hooks reference](https://code.claude.com/docs/en/hooks)
- [DOC] SessionStart:
  - `additionalContext` is "wrapped in a system reminder and placed at the start of the conversation" (model-visible, not a chat message).
  - It also takes `initialUserMessage` (only under `-p`), `sessionTitle` ("same effect as `/rename`", for source startup, resume or fork), `watchPaths` and `reloadSkills`.
  - Matchers: `startup|resume|clear|compact|fork`.
  - Plugins installed after SessionStart ran have `initialUserMessage` and `sessionTitle` ignored.
  
  — [Hooks reference](https://code.claude.com/docs/en/hooks)
- [DOC] Stop and SubagentStop: `decision:"block"` + `reason` keeps the agent going, and the reason becomes its next instruction (model-visible). `hookSpecificOutput.additionalContext` is "non-error feedback that continues the conversation". `last_assistant_message` is in the input — [Hooks reference](https://code.claude.com/docs/en/hooks)
- [DOC] **MessageDisplay** (display-only): it fires per batch of completed lines while an assistant message streams, with input `turn_id, message_id, index, final, delta`. `hookSpecificOutput.displayContent` replaces what is shown, and "The transcript and what Claude sees keep the original text, so Claude never sees the replacement." Default timeout 10 s — [Hooks reference](https://code.claude.com/docs/en/hooks)
- [DOC] PostToolUse `hookSpecificOutput.updatedToolOutput` "only changes what Claude sees" — [Hooks reference](https://code.claude.com/docs/en/hooks)
- [TYPES] Which `hookSpecificOutput` fields each event reads, for 2.1.316:
  - UserPromptSubmit: additionalContext, sessionTitle, suppressOriginalPrompt
  - SessionStart: additionalContext, initialUserMessage, sessionTitle, watchPaths, reloadSkills
  - PostToolUse: additionalContext, updatedToolOutput, updatedMCPToolOutput
  - Stop and SubagentStop: additionalContext
  - PermissionRequest: decision
  - MessageDisplay: displayContent
  - PreModelSwitch: permissionDecision and permissionDecisionReason
  
  `block`, `continue` and `stopReason` are read by every event — local `claude-code.d.ts` 2.1.316 (`ClassicResultFields`, line ~1396)
- [LOCAL] crosstalk already emits `hookSpecificOutput.additionalContext` and `{decision:"block",reason}` (Stop-style) in `/home/user/crosstalk/src/hook.ts` (lines ~229–273), and uses the hooks SessionStart, UserPromptSubmit, PostToolUse and Stop (`/home/user/crosstalk/hooks/hooks.json`).

### Inferences
- For "show the user, keep it from the model", the only settings-hook options are a synchronous `systemMessage` (a one-off warning line; on CwdChanged and FileChanged a brief toast-like notification), a UserPromptSubmit block `reason`, and MessageDisplay's `displayContent`. None of them is a persistent panel, and none takes input.
- A UserPromptSubmit block can serve as a model-free "command" (the user types `@crosstalk reply …`, the hook acts and blocks, the reason shows confirmation). But the prompt text still persists in the transcript file and prompt history, so it is not private. `suppressOriginalPrompt` only hides it from the on-screen block message.
- Do not use `async: true` for user-facing messages: it flips `systemMessage` to model-visible.

### Gaps
- Whether a blocked prompt plus its block message is ever replayed into model context on `--resume` is not documented. The docs only say it is written to the transcript file. [SPIKE]
- Exactly how a synchronous `systemMessage` renders per event (dim transcript row versus notification bar) is documented only for some events. [SPIKE]

---

## 3. Notification hook, terminal title, notifications, tab colour

### Takeaway
- The Notification hook fires for permission prompts (after about 6 s), idle (about 60 s), elicitations, agent-view events and plugin notifications. It can't block, and it discards `systemMessage`, but it can emit `terminalSequence`.
- Hooks can set the window or tab title through `terminalSequence` (OSC 0/1/2 allowlisted). Claude Code itself sets the title continuously from conversation context and is reported to overwrite titles set by others. `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` turns that off.
- **No allowlisted path sets tab colour.** OSC 1337 (iTerm2 SetColors / tab colour), palette OSCs and CSI are rejected.

### Cited Findings
- [DOC] Notification matchers and timing:
  - `permission_prompt`: "the prompt has waited about six seconds"
  - `idle_prompt`: "Claude finished responding about 60 seconds ago and you haven't typed since"
  - `auth_success`
  - `elicitation_dialog`: "you haven't typed for about six seconds"
  - `elicitation_url_dialog`, `elicitation_complete`, `elicitation_response`
  - `agent_needs_input` and `agent_completed` (agent view)
  - `quota_auto_resume_fired`, `quota_auto_resume_stale` and `quota_auto_resume_disabled` (v2.1.234+)
  - `plugin_notification`
  
  Input: `{hook_event_name:"Notification", message, title?, notification_type}`. It "can't block or modify notifications." — [Hooks reference](https://code.claude.com/docs/en/hooks)
- [DOC] `terminalSequence` (verbatim): "Hooks run without a controlling terminal, so writing escape sequences directly to `/dev/tty` fails. Instead, return the escape sequence in the `terminalSequence` field and Claude Code emits it for you… works inside tmux and GNU screen." The allowlist is "OSC `0`, `1`, `2`: window and icon titles; OSC `9`: iTerm2, ConEmu, Windows Terminal, and WezTerm notifications, including `9;4` taskbar progress; OSC `99`: Kitty notifications; OSC `777`: urxvt, Ghostty, and Warp notifications; Bare BEL". "Anything outside the allowlist, including CSI cursor and color sequences, OSC palette sequences, OSC 8 hyperlinks, OSC 52 clipboard writes, and OSC 1337, is rejected and the field is ignored." It works on events that discard `systemMessage` (Notification, StopFailure). It applies "only in an interactive session, and only while its interface is on screen", and is ignored in `-p` and the SDK — [Hooks reference](https://code.claude.com/docs/en/hooks)
- [DOC] `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`: "disable automatic terminal title updates based on conversation context. This also skips the background small/fast-model request that generates a session title, and turns off status reports to your terminal" — [Env vars](https://code.claude.com/docs/en/env-vars)
- [DOC] OSC 7501 Program Status Protocol (v2.1.295+): terminals that implement it show each session's working, waiting or done state. "The tab title doesn't start with a status glyph in a terminal that reports support… Claude Code leaves out the glyph it puts in front of the title in other terminals." There is no status report inside tmux, in background sessions, or with `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` — [Terminal config](https://code.claude.com/docs/en/terminal-config)
- [DOC] Built-in notifications: Ghostty, Kitty and iTerm2 get a desktop notification, Apple Terminal may get a silent bell, and other terminals get nothing. `preferredNotifChannel: "terminal_bell"` forces BEL. tmux needs `allow-passthrough on` — [Terminal config](https://code.claude.com/docs/en/terminal-config)
- [DOC] Agent view sets the tab title to the count of waiting sessions, e.g. `2 awaiting input · claude agents` — [Agent view](https://code.claude.com/docs/en/agent-view)
- [ISSUE] The title is overwritten continuously:
  - "`CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` only prevents terminal title changes at startup/shutdown, but Claude Code continuously sends OSC 0 escape sequences", with `/rename` titles overwritten (marked resolved) — [claudeissues #47397](https://claudeissues.com/issue/47397-claude-code-disable-terminal-title-1-doesnt-suppress-ongoing-title-updates-renam)
  - On exit the title was cleared despite the env var, on 2.1.70 (resolved) — [claudeissues #31641](https://claudeissues.com/issue/31641-bug-terminal-tab-title-cleared-to-empty-string-on-exit-despite-claude-code-disab)
  - The variable was ignored on Windows in 2.0.76 — [claudeissues #16572](https://claudeissues.com/issue/16572-bug-claude-code-disable-terminal-title-environment-variable-not-working-on-windo)
  - The title was locked to the CC version, with a request for customisation — [claudeissues #56933](https://claudeissues.com/issue/56933-allow-disabling-or-customizing-terminal-tab-title-currently-locked-to-cc-version); see also [GitHub #15802](https://github.com/anthropics/claude-code/issues/15802)
  - Ghostty: Claude Code "emits its own OSC 2 escape sequence to overwrite the title"; the workaround was the env var plus a zsh hook — [dev.to](https://dev.to/liran_baba/why-every-ghostty-tab-said-claude-code-and-the-30-line-zsh-hook-that-fixed-it-19h5)
- [TYPES] Mod `$.ui.notify(text, {title})` "raises a native notification… through the person's own notification channel, the one their `preferredNotifChannel` names". It first runs Notification hooks with `plugin_notification`, and resolves `{isSent, channel}` or `{isSent:false, reason: disabled|no-channel|no-surface|refused}` — local `claude-code.d.ts` 2.1.316
- [TYPES] There is no title or tab-colour method on the mod API: a grep of the 2.1.316 declarations finds no terminal-title setter. `sessionTitle` (a hook field, same as `/rename`) is the session's name, not a raw OSC title — local `claude-code.d.ts` 2.1.316

### Inferences
- The most robust way to set a tab title is a hook returning `terminalSequence: "\e]2;<title>\a"`. That races with Claude Code's own context-driven title updates unless the user sets `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`, which also kills the AI session title and OSC 7501. Setting `sessionTitle` (or `/rename`) may be the "cooperative" path, if Claude Code builds its OSC title from the session name. [SPIKE]
- Tab colour (iTerm2 OSC 1337 SetColors, OSC 6 tab colour, Kitty `@set-tab-color`) can't go through Claude Code. The crosstalk daemon would have to write to the terminal itself (e.g. the tty of the parent shell, or `kitty @`/`wezterm cli`/tmux commands), outside Claude Code's renderer.

### Gaps
- The exact title text Claude Code writes, and how often, in 2.1.31x. Whether it composes from `sessionTitle` or `/rename`. Whether a `terminalSequence` title persists until the next Claude-driven update. [SPIKE]

---

## 4. Plugin-provided UI: mods (panes, band above prompt, toasts, status, notices) and delivery interception

### Takeaway
Mods are the real plugin-UI API, documented since v2.1.287. A plugin adds `{"modules": ["./register.tsx"]}` to `hooks/hooks.json` and exports `register(on)`. It can then:
- draw a **Pane** (a sidebar in fullscreen mode, inline otherwise) or an **AbovePrompt band** with Box, Text, Button, Input, Select, Markdown, Link (OSC 8), Image and Raster elements
- raise **toasts**, a **status line**, dim **transcript notices** (`$.ui.log`, "not sent to the model") and native notifications
- ask questions in the native AskUserQuestion dialog (`$.ui.ask`)
- register model-free slash commands
- intercept incoming cross-session or channel messages with `session.receive` → `{consumed}`, which means "nothing is queued, shown or read by the model"

This is the best fit for crosstalk's goal of showing peers' status and questions and letting the user answer outside the model's context.

### Cited Findings
- [DOC] "A mod is a plugin that changes how Claude Code looks and behaves… JavaScript or TypeScript event handlers." It can "Draw an interface you can use: a pane beside the transcript or a band above the prompt, with tabs, buttons, and text fields", "Redraw Claude Code's own interface… a tool call's row, the spinner, or the dialog Claude asks questions in", and "Run your own code on a command: a `/command` that runs your function at once, with no Claude turn, even while Claude is working." — [Mods overview](https://code.claude.com/docs/en/plugins/mods/overview)
- [DOC] Versions: "Mods are on by default. In the terminal, use Claude Code v2.1.287 or later… Desktop… from v2.1.286." The `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` early-access variable is ignored from v2.1.287. Mods are turned off by `--safe-mode` or `disableAllHooks`, and admins can set `allowManagedModsOnly`. Hooks run in `-p` and the SDK but **nothing draws there**. Cloud sessions run hooks and draw nothing. Drawing works in the terminal, the Desktop Code tab and VS Code (extension 2.1.299+) — [Mods overview](https://code.claude.com/docs/en/plugins/mods/overview)
- [DOC] Security model: mods are not sandboxed and "can… submit a prompt as if you had typed it, or send a message to another of your sessions", "approve a tool call before you're asked". "A mod can restyle much of Claude Code's interface, but not the permission prompt." — [Mods overview](https://code.claude.com/docs/en/plugins/mods/overview)
- [DOC] The plugin manifest has a `types` field for a mod's `.d.ts`, and a plugin can mix a mod with skills, MCP servers and settings hooks — [Plugin manifest reference](https://code.claude.com/docs/en/plugins-reference); [Mods overview](https://code.claude.com/docs/en/plugins/mods/overview)
- [TYPES] Render sites (`RenderComponent`): `AskUserQuestion | UserMessage | AssistantMessage | ToolUse | ToolResult | ToolGroup | ToolProgress | CommandOutput | Spinner | TurnDuration | InfoNotice | SessionMode | PromptHint | AbovePrompt | Pane | Placed`. Surfaces: `terminal | desktop | vscode | mobile` — local `claude-code.d.ts` 2.1.316
- [TYPES] Panes: `$.ui.open({ id, title, focus, closeOnEscape, holdToasts, backgroundColor, rows, columns })` resolves `{isPlaced}`. "Unasked… it is placed from 144 columns, 110 for one once asked"; below that width it waits undrawn. It is drawn by an `on('ui.render', {component:'Pane', requestId:id}, …)` hook. Redraws are capped at "ten a second at most, thirty in the terminal for a shown pane, expanded band and prompt hint" — local `claude-code.d.ts` 2.1.316
- [TYPES] Toast: `$.ui.toast(text, {timeoutMs})`, default 4000 ms: "a small box on the stack of plugin toasts over the transcript's top right corner… It leaves the transcript and the model untouched." Status: `$.ui.status(text)`. Transcript notice: `$.ui.log(text)` "Appends one line to the transcript, drawn like a system notice (dim; not sent to the model)". Per-dialog line: `$.ui.notice(tool_use_id, text)` under an open permission or tool dialog — local `claude-code.d.ts` 2.1.316
- [TYPES] `$.ui.ask(question, options)` uses "the engine's own AskUserQuestion dialog and resolves to the label they chose, or the text typed under 'Other'". It rejects when dismissed and under `-p` — local `claude-code.d.ts` 2.1.316
- [TYPES] **`session.receive`**: "Fires when a delivery reaches the session, before it is queued: a relay's event, a peer's message, a Remote Control prompt, room events; `{ text }`. Rewrite with `next({ ...e, text })`, or return `{ consumed: reason }` to take it: nothing is queued, shown or read by the model." Its dual, `session.send`, fires when SendMessage or `$.session.send` sends a message to another session, and can rewrite it, readdress it or refuse it — local `claude-code.d.ts` 2.1.316 (line ~4525)
- [TYPES] `$.session.append({message:{type:"system", content:[text]}})` is a notice: "the model never reads it". `type:"user"` is a hidden user row the model **does** read. `$.prompt.submit` queues a prompt that starts its own turn once idle. `$.prompt.fill` writes into the prompt box. `prompt.submit` hooks can `{drop}` a prompt. The `UserMessage` render site tells peer and channel messages apart by `e.props.origin.kind` and `e.props.from.name`; "a rewritten `text` changes the row alone, never what the model read" — local `reference.md` 2.1.316 (`/tmp/claude-0/bundled-skills/2.1.316/104f091ba2eeb98476ffacc7b2bfe61e/plugin-authoring/reference.md`)
- [TYPES] Commands: `$.command.register({name, description})` in `session.start`, answered by a `command.run` hook returning `{ text, context? }`, where "`text` the row the model also reads, `context` notes only the model reads". The `CommandOutput` render site can redraw that row — local `reference.md` 2.1.316
- [TYPES] Other `$` nouns include `clock` (every and after), `fs`, `process.run`/`spawn`, `store` (across sessions), `state`, `model.complete`/`fork`, `agent.list`/`spawn`, `tool.register` (listed as `mcp__<plugin>__<name>`), `ui.view({agentId})` (switch the main view to an agent's transcript, only on a person-initiated action) and `ui.copy` (OSC 52) — local `reference.md` 2.1.316
- [TYPES] A Button can bind to a keybinding action (`action: "app:cycleDiffBase"`) and a `hotkey`. A Link draws "an OSC 8 span on the terminal". Image uses the kitty or iTerm2 graphics protocols — local `reference.md` 2.1.316
- [DOC] Built-in features are mods (`cc-plugin-diff` for `/diff`, `cc-plugin-you-should-know` for a band above the prompt), and their source is in [anthropics/claude-code/mods](https://github.com/anthropics/claude-code/tree/main/mods). Samples: [claude-code-playground/claude-code/mods](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods) — [Mods overview](https://code.claude.com/docs/en/plugins/mods/overview)
- [LOCAL] In this 2.1.316 session the `plugin-authoring` skill is installed as the built-in `cc-plugin-plugin-authoring`. Its SKILL text documents the pane, band, status, toast, command and tool.call shapes. Mods written in-session load only after the user answers an in-UI "Turn on the mods Claude writes in this session?" question.

### Inferences
- A crosstalk mod could:
  - keep a **Pane** or **AbovePrompt band** listing peer sessions (status from the daemon over `$.fs` or `$.process` or a network call, refreshed by `$.clock.every`)
  - **consume** incoming peer messages and questions in `session.receive`, so they show in the pane, a toast or a `$.ui.log` row instead of in context
  - give the user an Input or Buttons to answer, sending the reply through the daemon or `$.session.send` without the local model ever seeing it
  - hand chosen items to the model on purpose with `$.session.append({type:"user"})`
  
  This replaces the UserPromptSubmit-block and statusline workarounds.
- The pane only shows unasked at 144+ columns (or once opened by the user). In `-p`, the SDK, cloud and agent-view background sessions nothing draws, so a fallback is needed (e.g. `$.ui.log` or a classic `systemMessage`).
- The API is "early access" in the types header and its shape changes between releases. Pin a minimum version and test with `claude plugin validate` and `claude plugin test`.

### Gaps
- Whether `session.receive` sees messages written straight to the inbox socket (`~/.claude/sessions/<pid>.json` → `messagingSocketPath`) with `origin: "peer"`. The types list "a peer's message", which suggests yes. [SPIKE]
- Whether `$.ui.ask` answers are recorded in the transcript or model context (it is implemented as an AskUserQuestion `tool.call` through the hook chain). [SPIKE]
- Whether `$.ui.status` and toast text accept ANSI styling. [SPIKE]

---

## 5. Output styles, themes, keybindings, vim mode

### Takeaway
These are mostly cosmetic or local. A plugin can ship output styles and (experimental) themes. Keybindings and vim mode are user settings, and none of them gives a plugin a display channel separate from the model.

### Cited Findings
- [DOC] Plugin components include `outputStyles` (default `output-styles/`) and `experimental.themes` (default `themes/`). Themes show in `/theme` — [Plugin manifest reference](https://code.claude.com/docs/en/plugins-reference); [Terminal config](https://code.claude.com/docs/en/terminal-config)
- [DOC] Custom themes are `~/.claude/themes/<slug>.json` with `{name, base, overrides:{token: color}}`, hot-reloaded. Tokens include `claude`, `promptBorder`, `userMessageBackground`, `composerSidebarBackground` (the background of "a mod's pane") and `<color>_FOR_SUBAGENTS_ONLY`. "Claude Code does not control the terminal's own color scheme." — [Terminal config](https://code.claude.com/docs/en/terminal-config)
- [DOC] Keybindings: the file remaps actions such as `chat:newline` and `chat:submit`. Vim motions aren't remappable (use `vimInsertModeRemaps`). Vim mode is `editorMode: "vim"` — [Terminal config](https://code.claude.com/docs/en/terminal-config)
- [DOC] Fullscreen renderer: `/tui fullscreen` or `CLAUDE_CODE_NO_FLICKER=1`. Mod panes dock as a sidebar only in fullscreen — [Terminal config](https://code.claude.com/docs/en/terminal-config); [TYPES] `e.viewport.isFullscreen`

### Inferences
- Output styles change the system prompt (model-facing), so they don't help with hidden display.
- A plugin can't ship keybindings as far as the manifest reference shows (no `keybindings` component). A mod Button with `action:` can be pressed by the user's chord for that action.

### Gaps
- I did not fetch the keybindings doc. The exact `~/.claude/keybindings.json` schema and the full action list are not captured here (the local `keybindings-help` skill covers it).

---

## 6. Channels, MCP elicitation, permission relay, permission-prompt-tool

### Takeaway
- **Channels** push events into the **model's** context as `<channel source=… attr=…>` tags. The user sees a one-line `← source: text` summary. They are research preview and need `--channels` or `--dangerously-load-development-channels`.
- Channels can also opt in to **permission relay**. Claude Code sends the server `permission_request` notifications, and the server answers `allow` or `deny` without the model seeing the exchange.
- **MCP elicitation** shows the user a native form whose answer goes to the server.

### Cited Findings
- [DOC] Capability: `capabilities.experimental['claude/channel'] = {}`. Notification: `notifications/claude/channel` with `{content: string, meta?: Record<string,string>}`; meta keys must be identifiers, others are silently dropped. It arrives as `<channel source="webhook" path="/" method="POST">…</channel>`, and "Your terminal renders the event as a one-line summary, `← webhook: …`, rather than the raw tag." Events queue and are delivered together on the next turn if Claude is busy. There is no acknowledgement — [Channels reference](https://code.claude.com/docs/en/channels-reference)
- [DOC] Research preview: custom channels need `claude --dangerously-load-development-channels server:<name>` or `plugin:<name>@<marketplace>`, with a confirmation dialog. They are ignored under `-p` and the SDK. Org policy `channelsEnabled` applies, and `allowedChannelPlugins` replaces the Anthropic allowlist. The plugin manifest has a `channels: [{server, displayName, userConfig}]` field — [Channels reference](https://code.claude.com/docs/en/channels-reference); [Plugin manifest reference](https://code.claude.com/docs/en/plugins-reference)
- [DOC] Permission relay:
  - The server declares `experimental['claude/channel/permission'] = {}`.
  - It receives `notifications/claude/channel/permission_request` with `{request_id (5 letters a–z minus l), tool_name, description, input_preview}`.
  - It replies with `notifications/claude/channel/permission` and `{request_id, behavior: 'allow'|'deny'}`.
  - "Both stay live: you can answer in the terminal or on your phone, and Claude Code applies whichever answer arrives first."
  - Relay goes only to registered channels (v2.1.234+); text is sanitised (v2.1.211+) and credentials masked (v2.1.234+).
  - A verdict "goes to Claude Code as a verdict notification and never reaches Claude."
  
  — [Channels reference](https://code.claude.com/docs/en/channels-reference)
- [DOC] Elicitation and ElicitationResult hooks match on the MCP server name. They can answer `action: accept|decline|cancel` with `content` (form values), and exit 2 declines. Notification types cover `elicitation_dialog` and `elicitation_url_dialog` — [Hooks reference](https://code.claude.com/docs/en/hooks)
- [DOC] Under `--permission-prompts none` (v2.1.259+), "Any MCP elicitation request that no `Elicitation` hook answers is cancelled", and AskUserQuestion is removed — [Headless](https://code.claude.com/docs/en/headless)
- [DOC] `--permission-prompt-tool <mcp tool>` and the SDK's `canUseTool` callback are "permission hosts". Without `--permission-prompts none` a `-p` run waits on that host for each request. In Manual mode `-p` (default from v2.1.302) unapproved calls are denied unless a `PermissionRequest` hook or the prompt tool approves them — [Headless](https://code.claude.com/docs/en/headless)
- [DOC] `CLAUDE_CODE_DISABLE_PERMISSION_PROMPT_NOTIFY_HOOKS=1` (v2.1.233+): Desktop and VS Code host Claude Code via the SDK's `canUseTool` — [Env vars](https://code.claude.com/docs/en/env-vars)

### Inferences
- Channels are the wrong tool for "show without context", because their content always goes to the model. Their permission-relay half is a good fit for "answer another session's permission question remotely". A crosstalk channel server in each session could relay that session's permission prompts to the daemon, and peers or the user could answer from elsewhere. This needs the dev-channels flag until it is allowlisted.
- MCP elicitation (`elicitation/create` from crosstalk's MCP server) is a way to ask **this** session's user a structured question in a native form. The answer returns to the server, and the model sees only what the tool result says. It can only be raised during an MCP request (tool call) unless the server holds an open request. [SPIKE: whether a server can elicit unprompted, outside a tool call, in Claude Code]

### Gaps
- The exact JSON shape of Elicitation hook input was not captured (the docs page was truncated in my fetch).

---

## 7. Slash commands / skills with `!` bash execution

### Takeaway
`` !`cmd` `` and ```` ```! ```` blocks in a skill or command run before the content is sent, and **their output is inserted into what Claude receives**. The model always runs for a markdown skill or command. Only mod-registered commands (`$.command.register` + `command.run`) run without a model turn.

### Cited Findings
- [DOC] "The `` !`<command>` `` syntax runs shell commands before the skill content is sent to Claude. The command output replaces the placeholder, so Claude receives actual data." Permission rules are checked, with no prompt, and a non-allow aborts outside auto mode. A failing command aborts the whole invocation. Disable with `disableSkillShellExecution: true`. It is not run for claude.ai-synced skills (v2.1.228+) — [Skills](https://code.claude.com/docs/en/skills)
- [DOC] `disable-model-invocation` only stops auto-loading. "When you type `/name`, the rendered skill content is still sent to Claude" — [Skills](https://code.claude.com/docs/en/skills)
- [DOC] Mods: "a `/command` that runs your function at once, with no Claude turn, even while Claude is working" — [Mods overview](https://code.claude.com/docs/en/plugins/mods/overview)
- [TYPES] A `command.run` answer `{ text, context? }`: `text` is a transcript row "the model also reads", `context` is read by the model only. So even a mod command's reply text enters context. For display-only output, return minimal text and draw with `$.ui.log`, a toast or a pane — local `reference.md` 2.1.316

### Inferences
- crosstalk's existing markdown slash commands always cost a model turn and put their output in context. A `/crosstalk-reply` that must stay private needs a mod command, or a UserPromptSubmit block hack (which leaves the text on disk).

### Gaps
- Whether `!` output shows to the user in the transcript is not stated in the docs. [SPIKE]
- Whether a `command.run` answer with empty `text` leaves anything in model context. [SPIKE]

---

## 8. Headless / SDK: catching a background session's questions

### Takeaway
A session that crosstalk starts itself can be run with `claude -p --output-format stream-json --input-format stream-json` and a permission host (`--permission-prompt-tool` MCP tool, or SDK `canUseTool`). The daemon then catches every permission question and can answer it out-of-band. `--resume <id>` continues sessions. `terminalSequence`, mod drawing and channels do nothing under `-p`.

### Cited Findings
- [DOC] Flags:
  - `--output-format text|json|stream-json`, plus `--verbose --include-partial-messages` for token streaming
  - `--continue` and `--resume <id|path.jsonl>`
  - `--permission-mode` (`auto|dontAsk|acceptEdits|…`)
  - `--permission-prompts none` (v2.1.259+)
  - `--bare`
  - `--plugin-dir`
  - `--json-schema`
  
  The stream carries `system/init` (plugins, plugin_errors, mcp_servers, capabilities), `system/api_retry`, `permission_denied` system messages and the final `result` with `permission_denials`. Hook `systemMessage` "can arrive as an `SDKInformationalMessage`" — [Headless](https://code.claude.com/docs/en/headless); [Hooks reference](https://code.claude.com/docs/en/hooks)
- [DOC] "Without the flag, your run waits for that host to answer each permission request." Hosts are an Agent SDK app with a `canUseTool` callback, or `--permission-prompt-tool` — [Headless](https://code.claude.com/docs/en/headless) (callback detail at [Agent SDK user input](https://code.claude.com/docs/en/agent-sdk/user-input))
- [DOC] `--bg` and `-p` are mutually exclusive. Background sessions are managed through `claude agents --json`, `claude attach`, `claude logs` and `claude stop` — [Agent view](https://code.claude.com/docs/en/agent-view)
- [TYPES] Mod hooks run in `-p` and the SDK; `$.ui.log` reaches the host as `ui_log` messages; `$.ui.ask` rejects under `-p` — local `reference.md` 2.1.316

### Gaps
- I did not verify the exact `canUseTool` signature or the `--permission-prompt-tool` input/output JSON for 2.1.31x. (From memory, the tool returns `{"behavior":"allow","updatedInput":…}` or `{"behavior":"deny","message":…}`, but this needs confirming against [Agent SDK user input](https://code.claude.com/docs/en/agent-sdk/user-input).)

---

## 9. Session registry and inbox socket

### Takeaway
The public docs don't cover these. They were observed locally and in crosstalk's spike. Each live session writes `~/.claude/sessions/<pid>.json`, including a `messagingSocketPath` Unix socket that accepts newline-delimited JSON user messages, which arrive in the model's context.

### Cited Findings
- [LOCAL] `~/.claude/sessions/98.json` on 2.1.316 contains `pid, sessionId, cwd, startedAt, procStart, version, peerProtocol (1), peerFeatures (["notify_idle","reply_across_default_dirs","artifact_yield"]), kind ("interactive"), entrypoint ("remote_mobile"), pidDomain, asksForConvertedSkills, messagingSocketPath ("/tmp/cc-socks/98.sock"), name, nameSource ("derived"), nameSince, updatedAt, status ("busy"), statusUpdatedAt`. A sibling `98.<hash>.key` file also exists.
- [LOCAL] Wire format captured in `/home/user/crosstalk/spike/README.md` (Claude Code 2.1.263, macOS): `{"msgV":1,"msg_id":"<uuid>","type":"user","message":{"role":"user","content":"<cross-session-message from=… from-name=… from-mode=…>…</cross-session-message>"},"priority":"next","from":"uds:<sender sock>"}`. The sender builds the wrapper, and Claude Code adds its own framing saying the message came from another session. `ListAgents` sends a 0-byte connect-only liveness probe. A fake registry entry appears as a peer.
- [DOC] Agent view's background sessions use different state: `~/.claude/jobs/<id>/state.json`, `~/.claude/daemon/roster.json` and `daemon.log`. "files under `jobs/` are not a stable interface"; use `claude agents --json` — [Agent view](https://code.claude.com/docs/en/agent-view)
- [TYPES] `session.receive` (deliveries: "a peer's message, a Remote Control prompt, room events") and `session.send` (SendMessage) are hookable by mods — local `claude-code.d.ts` 2.1.316

### Inferences
- The registry's `status` field (busy, idle and so on) plus `name` is enough for the daemon to show peer status without asking Claude Code. Socket messages go to the model by default. A mod's `session.receive` → `{consumed}` is the documented-in-types way to stop that and show them in UI instead.

### Gaps
- Neither the registry nor the socket is publicly documented or promised to be stable. The values of `status` and the meaning of `peerFeatures` are not documented. [SPIKE]

---

## 10. Claude Code's own multi-session features that overlap

### Takeaway
Claude Code now has its own multi-session workspace: agent view and background sessions with Needs-input states and a peek or reply panel, `/background` and `/fork`, Agent Teams, subagent panels, `/tasks`, Remote Control and mobile push, and OSC 7501 per-session terminal status. These overlap heavily with a "terminal as agent workspace" product.

### Cited Findings
- [DOC] Agent view:
  - `claude agents` opens it. Sessions are grouped Pinned, Ready for review, Needs input, Working and Completed, with states Working, Needs input, Idle, Completed, Failed and Stopped.
  - Space peeks at "the exact question". Typing replies, but "for permission prompts replying doesn't answer it… attach with `→`".
  - It sends notifications through the terminal channel and fires `agent_needs_input` and `agent_completed` Notification hooks.
  - Sessions start with `claude --bg`, `/background`, `/fork`, `claude --resume <id> --bg`. Each runs in its own worktree under `.claude/worktrees/`. A supervisor daemon stops idle unattached sessions after about an hour.
  - It is research preview.
  
  — [Agent view](https://code.claude.com/docs/en/agent-view)
- [DOC] OSC 7501 lets the terminal show each interactive session's working, waiting or done state (v2.1.295+); background sessions don't report — [Terminal config](https://code.claude.com/docs/en/terminal-config)
- [DOC] Remote Control and mobile push notifications exist (`CLAUDE_CLIENT_PRESENCE_FILE`, v2.1.181+). The PushNotification tool skips desktop and mobile notifications when the user is active (v2.1.193+) — [Env vars](https://code.claude.com/docs/en/env-vars)
- [DOC] Mods draw in the Desktop Code tab and VS Code, and under Remote Control in the terminal on the user's machine — [Mods overview](https://code.claude.com/docs/en/plugins/mods/overview)
- [TYPES] `$.agent.list()` and `$.ui.view({agentId})` let a mod switch the main view to an agent's transcript "as the person's own switch from the tasks list does" — local `reference.md` 2.1.316
- [LOCAL] This very session's registry entry has `entrypoint: "remote_mobile"`, i.e. it is driven over Remote Control from mobile.

### Inferences
- crosstalk's value over the built-ins is in **cross-machine, cross-user rooms** and **peer-to-peer questions between sessions**. Agent view only covers one user's local background sessions, and it can't answer permission prompts from the peek panel. A crosstalk mod pane could add exactly that: answer a peer's permission prompt via channel permission relay or the daemon, not just queue a message.

### Gaps
- The details of `/tasks`, Agent Teams messaging and Remote Control's peer protocol were not fetched in depth. Whether agent view's sessions also write `~/.claude/sessions/<pid>.json` is unconfirmed. [SPIKE]
