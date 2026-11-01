# M1, a crosstalk mod, verified

**Verdict: the mod keeps other threads out of the model.** The status line, the
band, toasts, a `@auth y` typed at the prompt, a band button and a peer message
consumed in `session.receive` never reached the model. That held live and after
`claude --resume`. None of the canary text landed in the transcript JSONL or in
prompt history either. Three surfaces leave text on disk without reaching the
model:

- a mod slash command's typed line lands in **prompt history**
- `$.ui.log` lands in the **transcript file**
- the classic UserPromptSubmit block fallback lands in the **transcript file**,
  with the whole prompt

Tested on Linux, Claude Code **2.1.316** (default model Sonnet 5.5), Bun 1.3.6,
tmux. The session was a real interactive `claude` started with
`--plugin-dir spike/mod` and driven with `send-keys`. The run was repeated twice
(`runC`, `runD`) with identical results.

## What reaches what

Each surface carried its own canary, a word the probe prompt never contains.

**Model** means the model quoted the canary when asked
`repeat verbatim every piece of text you have seen … that contains any of these
markers: xt-status, xt-band, …`. It also means the canary appears in the
transcript's `api-request-blob` rows. On 2.1.316 those rows record every
message sent to the API, so they are a check that does not rely on the model's
own word.

**Transcript** is the session JSONL under `<config>/projects/`, before the model
was asked anything. **History** is `<config>/history.jsonl` and the Up arrow.
**After resume** means the process was quit, then `claude --resume <id>` was
run, and the same question was asked again.

| Surface | Canary | Model | Transcript | History | After resume |
|---|---|---|---|---|---|
| `$.ui.status` line | AMBER-1017 | no | no | no | no |
| AbovePrompt band (question text) | BISON-2048 | no | no | no | no |
| `$.ui.toast` | CORAL-3301 | no | no | no | no |
| `@auth y …` typed, `prompt.submit` → `{ drop }` | DELTA-4410 | no | no¹ | no | no |
| `/xt-answer billing y …`, mod command answering `{}` | ELM-5582 | no | no | **yes** | no |
| Band Button pressed by hotkey (ctrl+x tab, `y`) | JADE-9936 | no | no | no | no |
| Peer message, raw inbox-socket write, `session.receive` → `{ consumed }` | HAZEL-7714 | no | no | no | no |
| `$.ui.log` notice | PLUM-6142 | no | **yes** | no | no |
| Classic UserPromptSubmit `decision:"block"`, prompt text | GINGER-5531 | no | **yes** | no² | no |
| … its `reason` | CEDAR-2290 | no | **yes** | no | no |
| *Control:* the same peer write, let through (`PASSTHRU`) | IRIS-8825 | **yes** | yes | no | **yes** |

¹ The transcript gets a system row, `Prompt dropped by a hook: crosstalk: answer
sent to auth`. That is the mod's own drop reason, not the typed text.
² This contradicts the report, which says a blocked prompt lands in history. On
2.1.316 it does not, in either `history.jsonl` or the Up arrow.

The control row is the proof that the method works. A raw socket write that the
mod lets through reaches the model, is stored, and comes back after a resume.
The identical write that the mod consumes leaves no trace in any of the three
places.

The debug log (`--debug`, `<config>/debug/<session>.txt`) is outside the table.
It records status and toast text, the drop and block reasons, and the blocked
prompt. It is local and only exists with `--debug`.

## Evidence

`spike/mod/run/leaks.sh runD`, the canary counts on disk:

```
surface      canary      transcript sent   history  resume-sent
status       AMBER-1017  0          0      0        0
band         BISON-2048  0          0      0        0
toast        CORAL-3301  0          0      0        0
@auth        DELTA-4410  0          0      0        0
/command     ELM-5582    0          0      1        0
band-button  JADE-9936   0          0      0        0
block        GINGER-5531 1          0      0        0
block-why    CEDAR-2290  1          0      0        0
peer         HAZEL-7714  0          0      0        0
ui.log       PLUM-6142   1          0      0        0
control      IRIS-8825   3          1      0        1
```

The model's answer, live and again after `--resume`, was identical in both runs:

```
- xt-status: NONE        - xt-band: NONE        - xt-band2: NONE     - xt-band3: NONE
- xt-toast: NONE         - xt-at: NONE          - xt-cmd: NONE       - xt-block: NONE
- xt-reason: NONE        - xt-peer: NONE        - xt-log: NONE
- xt-ctrl: PASSTHRU xt-ctrl control message IRIS-8825
```

The three transcript rows that hold canaries, none of them sent:

```json
{"type":"system","subtype":"informational","level":"warning","content":"UserPromptSubmit operation blocked by hook:\ncrosstalk fallback: answer recorded xt-reason CEDAR-2290\n\nOriginal prompt: %xt auth y xt-block GINGER-5531","preventContinuation":true,"promptSubmitEnding":{"ending":{"kind":"blocked_by_hook",…},"promptKept":false}}
{"type":"system","subtype":"informational","level":"notice","content":"crosstalk-spike: crosstalk: took a peer message (peer); see the band. xt-log PLUM-6142"}
```

And `history.jsonl`: `"display":"/xt-answer billing y xt-cmd ELM-5582"`.

The debug log for the consumed peer message:

```
session.receive (peer): consumed by a hook (crosstalk-spike: shown in the band; hooked by crosstalk-spike); not queued
```

The control was routed the normal way:
`[uds-messaging] Routed user message to queue (priority=next)`.

What the screen showed (`capture-pane`), at start:

```
                                                │ crosstalk-spike                  │
                                                │ xt-toast auth is waiting on you  │
                                                │ CORAL-3301                       │
@auth xt-band rotate the signing key now? BISON-2048 [ y ][ n ]                  [-]
@billing xt-band2 retry the failed invoices? FALCON-6603 [ y ][ n ]
@infra xt-band3 drain node 4? JADE-9936 [ y ][ n ]
────────────────────────────────────────────────────────────────────────────────
❯ Try "write a test for <filepath>"
────────────────────────────────────────────────────────────────────────────────
  ⚠ crosstalk-spike: ◢ auth, billing, infra · 3 waiting · xt-status AMBER-1017
```

After the peer message:

```
● crosstalk-spike: crosstalk: took a peer message (peer); see the band. xt-log PLUM-6142
← marie/api: xt-peer the migration landed HAZEL-7714                             [-]
[ clear messages ]
```

**An idle session gets a push.** A question written to the file while the
session sat idle, with no prompt and no turn, showed up in the band, the status
line and a toast within a second, from the `$.clock.every` poll.

## What else the runs showed

- **`session.receive` sees raw inbox writes.** A write in the
  `src/inject.ts` shape, with no auth line, arrives with
  `origin.kind === "peer"` and its full text. That settles the report's spike
  question: the daemon can keep using the socket.
- **A drop hands the text back to the prompt box.** After a `{ drop }`, or a
  classic block, the typed `@auth y …` sits in the box again. The next Enter
  would send it on, and it lands in history. The mod clears the box with
  `$.prompt.fill({ text: '' })` 150 ms after the drop, and that works. The
  classic block cannot do this. The first run of this spike typed its probe
  onto a leftover blocked prompt and got the probe blocked.
- **The status line is labelled by the engine.** It is drawn as
  `⚠ crosstalk-spike: ◢ …`, so the plugin's name prefixes the design's
  `◢ auth · 2 waiting`. Whether the `⚠` is there only for a `--plugin-dir`
  plugin is untested.
- **`$.state` does not survive a new process.** After `--resume` the band showed
  all three questions again as unanswered. `$.state` survives a hot reload, not
  a restart. The daemon has to own whether a question was answered.
- **`!` is bash mode.** The first fallback prefix tried, `!xt`, ran as a shell
  command and put the text in the model's context. The fallback must never use
  a prefix Claude Code already claims (`!`, `/`, `#`, `&`).
- **The validator is strict about `$`.** Helpers that take `$` must be top-level
  `function` declarations. A closure inside `register` is refused.

## Consequences for the design

1. **The rule "a question never enters another thread's context" holds** for
   the status line, band, toasts, band buttons, `@thread` drops and consumed
   peer messages. That holds on 2.1.316, live and after resume.
2. **Answer in the band, or with a typed `@thread`. Not with a slash command.**
   A mod command keeps its typed line, answer included, in prompt history. That
   is not the model, but it is on disk and comes back on the Up arrow.
   `@auth y` through `prompt.submit` leaves only the mod's own drop reason. So
   that reason should name the thread and not quote the answer.
3. **Never put question or message text in `$.ui.log`.** It is written to the
   transcript file. Use toasts, the band or the status line, which leave
   nothing.
4. **The no-mods fallback is weaker than the design says, in a different way.**
   A blocked prompt and its reason are written to the transcript in full, as
   `Original prompt: …`, and the prompt is not in history. The fallback also
   cannot clear the box, so the blocked text is one Enter from being sent.
5. **Consume by default.** The spike's `session.receive` hook has a `.catch`
   that consumes on failure, so a broken hook holds a message back rather than
   letting it through. Ship it that way.
6. **Spike evidence is cheap from here.** The transcript's `api-request-blob`
   rows show exactly what went to the API. A regression test can grep them
   instead of asking the model.

## M2: the picker, the card and the pane, verified

**Verdict: all three surfaces of "Messages are UI" work, and none of them
reaches the model unless the person hands a message over.** Claude Code's own
question picker (`$.ui.ask`), a boxed and coloured message card in the band,
and a thread pane stayed out of the model, the transcript file, prompt history
and a resumed session. That held for the question, the chosen answer and the
options not chosen, idle and mid-turn. Pressing ↵ on a card put that card,
and only that card, in front of the model, and it stayed there after
`--resume`. Four things work differently from what the design assumes; see
[What contradicts the design](#what-contradicts-the-design).

The mod is a second plugin, `spike/mod/surfaces/` (the M1 mod is untouched).
Same build (Claude Code 2.1.316, Sonnet 5.5), same method: a real interactive
`claude --plugin-dir spike/mod/surfaces` in tmux, driven by `send-keys`, an
isolated `CLAUDE_CONFIG_DIR`, one canary per surface, and a probe that asks
the model to quote every marker it has seen. The probe ran three times:
before ↵, after ↵, and after quitting and running `claude --resume`.

### What reaches what

| Surface | Canary | Model | Transcript | History | After resume |
|---|---|---|---|---|---|
| `$.ui.ask` question, idle | QUAIL-1101 | no | no | no | no |
| … the option picked (digit `2`) | SWIFT-1103 | no | no | no | no |
| … an option not picked | ROBIN-1102 | no | no | no | no |
| `$.ui.ask` question, mid-turn | WREN-2201 | no | no | no | no |
| … the option picked (digit `1`) | LARK-2202 | no | no | no | no |
| … an option not picked | MYNA-2203 | no | no | no | no |
| `$.ui.ask` dismissed with Esc | OWL-7701 | no | no | no | no |
| Card 1 text, **after ↵** | MOSS-3301 | **yes**¹ | **yes**² | no | **yes** |
| Card 1 attachment chip, **after ↵** | FERN-3302 | **yes**¹ | **yes**² | no | **yes** |
| Card 2 text, shown then muted (`m`) | REED-4401 | no | no | no | no |
| Card 2 attachment chip | SEDGE-4402 | no | no | no | no |
| Pane, thread as first written | BIRCH-5501 | no | no | no | no |
| Pane, after the thread file changed | ASPEN-5502 | no | no | no | no |
| `$.ui.status` with ANSI and OSC 8 | TEAL-6601 | no | no | no | no |
| `$.ui.toast` with ANSI and OSC 8 | LIME-6602 | no | no | no | no |

¹ Only after ↵. The probe before ↵ answered `xt-card1: NONE`, and no
user-side request row held MOSS-3301 or FERN-3302 until then (`sent<↵` below).
² On purpose: `$.session.append` stores the handed message as one user row,
`isMeta: true`, the moment ↵ is pressed.

The debug log (`--debug`) holds the status and toast text, as in M1, and
nothing from the picker, the cards or the pane.

### Evidence

`spike/mod/surfaces/run/leaks.sh <run-dir>`, the canary counts on disk.
`stored`: transcript rows other than request blobs and the model's own
replies. `sent<↵` and `sent`: user-role `api-request-blob` rows (what went to
the API from the user side) before ↵ and at the end of the live session.
`resume`: user-role rows first sent after `--resume` (a resent row keeps its
blob, so 0 there means nothing new, not that the model lost it).

```
surface         canary      stored  sent<↵ sent   history  resume  debug
ask-question    QUAIL-1101  0       0       0      0        0       0
ask-chosen      SWIFT-1103  0       0       0      0        0       0
ask-unchosen    ROBIN-1102  0       0       0      0        0       0
ask2-question   WREN-2201   0       0       0      0        0       0
ask2-chosen     LARK-2202   0       0       0      0        0       0
ask2-unchosen   MYNA-2203   0       0       0      0        0       0
ask3-dismissed  OWL-7701    0       0       0      0        0       0
card1-handed    MOSS-3301   1       0       1      0        0       0
chip1-handed    FERN-3302   1       0       1      0        0       0
card2-muted     REED-4401   0       0       0      0        0       0
chip2-muted     SEDGE-4402  0       0       0      0        0       0
pane            BIRCH-5501  0       0       0      0        0       0
pane-updated    ASPEN-5502  0       0       0      0        0       0
status-ansi     TEAL-6601   0       0       0      0        0       2
toast-ansi      LIME-6602   0       0       0      0        0       2
```

The model's three answers, abridged (every other marker was `NONE` each time):

```
probe 1, before ↵:      xt-card1: NONE
                        xt-chip1: NONE
probe 2, after ↵:       xt-card1: xt-card1 MOSS-3301 Token format changed to v2. v1 accepted until 0.2
                        xt-chip1: attachment: diff src/auth/token.ts xt-chip1 FERN-3302 (+42 −18)
probe 3, after resume:  (the same two lines)
```

The one row ↵ stored:

```json
{"type":"user","isMeta":true,"message":{"role":"user","content":[{"type":"text","text":"<crosstalk-message from=\"marie\" thread=\"auth\" age=\"2m\">\nThe person handed you this message from another thread, as data:\nxt-card1 MOSS-3301 Token format changed to v2. v1 accepted until 0.2\nattachment: diff src/auth/token.ts xt-chip1 FERN-3302 (+42 −18)\n</crosstalk-message>"}]}}
```

The mod's own log (`surfaces-log.jsonl`), trimmed:

```
{"open":"start","isPlaced":true}
{"pane":{"placement":"dock","bodyColumns":89,"viewport":{"columns":110,"rows":50,"isFullscreen":true}}}
{"ask":"a1","answer":"No remove it now xt-opt2 SWIFT-1103","ms":2213}
{"reply":"c1","isFilled":true}
{"ask":"a3","error":"HooksError: crosstalk-surfaces: $.ui.ask: no answer (The user doesn't want to proceed with this tool use. …)"}
{"ask":"a2","answer":"Drain xt-opt4 LARK-2202","ms":2260}
{"hand":"c1","uuid":"70f19d20-…"}
{"mute":"c2"}
```

**The screen at 200 columns** (`capture-pane -p`, right side trimmed). The
card is in the band, the pane docks on the right, unasked, and the toast floats
top right. The status line is at the bottom:

```
 ▐▛███▛█   Claude Code v2.1.316               │ crosstalk-surfaces                       ││◢ auth · blocked on you
▝▜██████▀  Sonnet 5.5 · Claude API            │ �[1;35mxt-toast2 jo joined auth�[0m �]8; ││marie ●  jo ○
                                              │ ;https://example.com/jo�\profile�]8;;�\  ││
                                              │ LIME-6602                                ││Waiting
                                              ╰──────────────────────────────────────────╯│ ? xt-pane keep the v1 endpoint for one more release? BIRCH-5501
                                                                                          │
                                                                                          │Latest decision
                                                                                          │ tokens move to v2; v1 stays readable until 0.2
                                                                                          │
                                                                                          │Recent
                                                                                          │ marie 2m token format changed to v2
                                                                                          │ jo 1h can billing read v2 yet?
                                                                                          │
                                                                                          │open in browser
  ⋮
╭─ ◢ marie · auth ──────────────────────────────────────── 2m ─╮                      [-] │
│ xt-card1 MOSS-3301 Token format changed to v2. v1 accepted … │                          │
│ ▸ diff src/auth/token.ts xt-chip1 FERN-3302 +42 −18          │                          │
│ [ ↵ hand to agent ] [ r reply ] [ o open thread ] [ m mute ] │                          │
╰──────────────────────────────────────────────────────────────╯                          │
╭─ ◢ jo · billing ──────────────────────────────────────── 9m ─╮                          │
│ xt-card2 Invoice retries move to 5pm REED-4401               │                          │
│ ▸ file invoices.csv xt-chip2 SEDGE-4402 2 KB                 │                          │
│ [ ↵ hand to agent ] [ r reply ] [ o open thread ] [ m mute ] │                          │
╰──────────────────────────────────────────────────────────────╯                          │
──────────────────────────────────────────────────────────────────────────────────────────────────────
❯ Try "refactor <filepath>"
──────────────────────────────────────────────────────────────────────────────────────────────────────
  ⚠ crosstalk-surfaces: ◢ auth · tokens   marie �[32m●�[0m  jo �[2m○�[0m   �[1;33m2 waiting�[0m �]8;;https://example.com/xt�\xt-stat link�]8;;�\ TEAL-6601
```

**Colour, from `capture-pane -e -p`.** Hex colours come out as 256-colour
SGR. Sender `#d7875f` became `38;5;180` (bold) and thread `#5fafd7` became
`38;5;110`. The frame `#6c6c6c` became `38;5;242`, the chip's `suggestion`
theme key `38;5;153` and the dim size `38;5;246`. The primary Button is
`1;38;5;153`. The band's focus ring is inverse, `1;7`. The pane's `Link` is a
real OSC 8 span:

```
^[[38;5;242m╭─ ^[[1m^[[38;5;180m◢ marie^[[0m^[[38;5;242m · ^[[38;5;110mauth^[[38;5;242m ──────…
^[[38;5;242m│ ^[[1m^[[38;5;153m[ ↵ hand to agent ]^[[0m ^[[1m[ r reply ]^[[0m ^[[1m[ o open thread ]^[[0m ^[[1m[ m mute ]^[[0m …
^[]8;id=ocg7s9;https://example.com/crosstalk/thread/auth^[\open in browser^[]8;;^[\
```

**The picker**, idle (mid-turn looks the same, with the reply still streaming
above it):

```
 ☐ auth asks

xt-ask Keep the v1 endpoint for one more release? QUAIL-1101

❯ 1. Yes until 0.2 xt-opt1 ROBIN-1102
  2. No remove it now xt-opt2 SWIFT-1103
  3. Open the thread xt-opt3 TERN-1104
  4. Type something.
───────────────────────────────────
  5. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel
```

**The pane at 100 columns**, opened with `o` on a card (it sits inline above
the band, and the band scrolls under it), after the thread file changed:

```
╭────────────────────────────────────────────────────────────────────────────────────────────────✕─╮
│ ◢ auth · working                                                                                 │
│ marie ●  jo ●                                                                                    │
│                                                                                                  │
│ Waiting                                                                                          │
│  ? xt-pane2 drain node 4 before the rollout? ASPEN-5502                                          │
│                                                                                                  │
│ Latest decision                                                                                  │
│  keep v1 until 0.2 (answered just now)                                                           │
│                                                                                                  │
│ Recent                                                                                           │
│  jo now joined auth                                                                              │
│  marie 2m token format changed to v2                                                             │
│                                                                                                  │
│ open in browser                                                                                  │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
│ ▸ diff src/auth/token.ts xt-chip1 FERN-3302 +42 −18          │                                [-]
│ [ ↵ hand to agent ] [ r reply ] [ o open thread ] [ m mute ] │
↑ 2 more · ↓ 6 more
────────────────────────────────────────────────────────────────────────────────────────────────────
❯ Try "write a test for <filepath>"
```

### What else the runs showed

- **The picker answers by digit, idle or mid-turn.** `2` picked the second
  option at once, and `$.ui.ask` resolved with its label about 2 s after the
  question was raised. Mid-turn, the reply kept streaming under the dialog
  (it went from "one hundred fifty-six" to "two hundred six" while the
  question was up) and the turn finished normally. Esc rejects the ask
  (`HooksError … no answer`), and the dialog adds "Type something." (free text)
  and "Chat about this" to every question. "Chat about this" was not tried.
- **The picker takes the keyboard and hides the draft.** Raised while
  `half a draft` was typed, it replaced the prompt box. The two letters typed
  next were swallowed. After Esc the draft came back intact, without them. In
  an earlier run, a stale question raised again after `--resume` popped up
  just as the probe was typed: the probe's letters were swallowed and its
  Enter answered option 1.
- **`header` is a 12-character chip** (`☐ auth asks`). The design's
  `◢ api-worker · auth asks` does not fit there and belongs in the question.
- **The card is drawn by hand.** `Box` has no border title, so the
  `╭─ ◢ marie · auth ──── 2m ─╮` header is a `Text` row, and so are the sides
  and the bottom. It lays out exactly at any width; the mod caps it at 64
  columns and truncates the body with `…`.
- **The card's keys need the band focused.** ctrl+x tab focuses the band.
  The ring starts on the first card's ↵ (`autoFocus`), so Enter hands it over.
  After that, `r`, `o` and `m` are hotkeys of the first card only, since two
  cards' hotkeys would clash. At the prompt, Enter submits the prompt and `r`
  types an r.
- **↵ uses `$.session.append`**, a user row of text the model reads at its
  next request. It starts no turn, and the person sees no row for it, only
  the mod's toast `handed marie · auth to the agent`. If the agent should act
  on the message at once, the mod has to `$.prompt.submit` as well.
- **`r` fills the box with `@auth `** (`$.prompt.fill`), ready for the M1
  `prompt.submit` hook to take as an answer. `m` hides the card and toasts
  `muted billing`.
- **Where the pane goes.** The mod opens it unasked at `session.start`:

  | Terminal | Unasked open at start | `o` on a card (asked) |
  |---|---|---|
  | 200 columns, fullscreen (tmux's default on 2.1.316) | placed, docked right, 89 body columns | already open |
  | 130 columns, fullscreen | `isPlaced: false`, "unasked below 144 columns (130 now)" | placed, docked, 57 body columns |
  | 100 columns, fullscreen | `isPlaced: false` | placed **inline** above the prompt, sharing the bottom half with the band, which then scrolls |
  | 200 columns, main screen (`CLAUDE_CODE_NO_FLICKER=0`) | placed **inline**, full width above the band | already open |
  | 100 columns, main screen | `isPlaced: false` | placed inline |

  A docked pane that is narrowed below 110 columns moves inline by itself. An
  unplaced pane waits; `$.ui.panes()` reports it with `isPlaced: false`.
- **The pane redraws on its own.** The mod polls the thread file and writes it
  into a `$.state` atom, and the pane redrew within the half-second poll,
  docked and inline. After `--resume`, `session.start` opened it again.
- **The status line and toasts take plain text only.** Every ESC byte of
  `\033[32m●\033[0m` and `\033]8;;url\033\\…` is drawn as `�` followed by the
  rest of the sequence as literal text, in the status line and in the toast,
  in both layouts. The status line is drawn whole in the warning colour behind
  `⚠ crosstalk-surfaces:`. Colour and links work only in `ui.render` trees
  (`Text color`, `Link`). In main-screen layout the toast is a line in the
  footer, not a floating box.
- **A card's state does not survive a restart**, as in M1: after `--resume`,
  the handed and the muted card were both in the band again. A second ↵ would
  hand marie's message over twice.

### What contradicts the design

1. **"Your agent reads nothing until you press ↵" holds, but ↵ is not one
   key at the prompt.** The person presses ctrl+x tab first, and only then
   ↵, `r`, `o`, `m`. One card at a time gets the letter hotkeys. Either the
   band says `ctrl+x tab` on the card, or crosstalk binds a chord with a
   Button's `action` (pressed from the prompt), or `@auth` at the prompt is
   the main way in.
2. **The picker steals keys.** Raised while the person types, it swallows
   what they type, and an Enter meant for the prompt answers the highlighted
   option. Raise a question only when the composer is empty and idle
   (`$.prompt.read()`), or put it in the band first and open the picker on a
   keypress. Never re-raise an old question on its own after a restart.
3. **The status line cannot be coloured.** `marie ●  jo ○` has to carry its
   meaning in glyphs. It also arrives prefixed `⚠ crosstalk-surfaces:` and in
   the warning colour (at least under `--plugin-dir`), so the design's
   `◢ auth · tokens …` is never the first thing on the line. Links belong in
   the pane or a card (`Link`), never in status or toast text.
4. **The pane is a sidebar only from 144 columns, and only in fullscreen.**
   Below 144 it waits until the person opens it (`o`, a command). Below 110,
   or on the main screen, it sits above the prompt and competes with the band
   for the bottom half. "On a wide terminal, or the main session" holds; the
   main session should open it on request when its terminal is narrow.
5. **Handing over is silent in the transcript.** The model gets the message
   as a hidden user row and the person sees only a toast. The design should
   add a visible, model-invisible receipt (`$.ui.place`, which the types
   document as never read by the model, is untested here). It should also
   decide whether ↵ also starts a turn.
6. **The daemon must own a card's handed or muted state**, for the same reason
   as M1's questions. Otherwise a resumed session offers the same message
   again.

### Running it

```
spike/mod/surfaces/run/drive.sh <run-dir> xs     # ~4.5 minutes, three model probes
spike/mod/surfaces/run/leaks.sh <run-dir>
spike/mod/surfaces/run/widths.sh <run-dir> xw    # ~1.5 minutes, no model calls
```

- `surfaces/hooks/register.tsx`: the mod, about 250 lines. It polls
  `$CROSSTALK_SPIKE_DIR/surfaces-{cards,thread,ask}.json` and
  `surfaces-{status,toast}.txt` every 500 ms and appends what it did to
  `surfaces-log.jsonl`.
- `surfaces/types/index.d.ts`: its `$.state` contract.
- `surfaces/run/setup.sh <run-dir> <tmux> [columns] [no-flicker]`: seeds the
  files (two cards, a thread, ANSI status and toast) and starts the session.
  It reuses `run/env.sh`.
- `surfaces/run/drive.sh`: the run above. `run/thread2.sh` rewrites the
  thread file. `run/widths.sh` runs the pane table.

## Wiring

A mod is a plugin whose `hooks/hooks.json` names a module:
`{ "modules": ["./register.tsx"] }`. This spike is its own plugin, loaded with
`--plugin-dir spike/mod`, so the shipped `hooks/hooks.json` is untouched. To
ship it, add `"modules"` beside the existing `"hooks"` key of the plugin's
`hooks/hooks.json`. `claude plugin validate` accepts a file with both keys.
Whether both load in one session is untested.

## Not proven here

- A `command.run` answer that returns `text` (documented as read by the
  model). (`$.ui.ask`, the Pane, cards and ANSI in the status line are now
  covered in [M2](#m2-the-picker-the-card-and-the-pane-verified) above.)
- Whether a compaction summary could pick up any of the transcript-only rows.
- The Desktop and VS Code surfaces. A session with mods off (`--safe-mode`,
  `disableAllHooks`, `allowManagedModsOnly`). macOS.
- The Up arrow was checked only for its most recent entry.

## Files

- `hooks/register.tsx`: the mod, about 150 lines. It polls
  `$CROSSTALK_SPIKE_DIR/spike-questions.json` and `spike-status.txt` (default
  `~/.crosstalk`) every second, and writes `spike-answers.json` and
  `spike-received.json`.
- `types/index.d.ts`: its `$.state` contract.
- `run/drive.sh <run-dir> <tmux-session>`: one whole run. It sets up an isolated
  `CLAUDE_CONFIG_DIR` (`run/setup.sh`), raises each surface, probes live, quits,
  resumes and probes again. It needs a working Claude login.
- `run/leaks.sh <run-dir>`: the canary counts above.
- `run/peer.ts`: writes to the session's inbox socket through `src/inject.ts`.
- `run/block-hook.ts`: the classic UserPromptSubmit fallback, blocking `%xt …`.
- `run/env.sh`: strips a hosting Claude Code's environment (remote entrypoint,
  inbox socket) so the child is a plain local session. It is needed only when
  the spike runs inside another Claude Code.

```
spike/mod/run/drive.sh /tmp/xt-run xt      # ~2.5 minutes
spike/mod/run/leaks.sh /tmp/xt-run
```
