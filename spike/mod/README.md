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

## Wiring

A mod is a plugin whose `hooks/hooks.json` names a module:
`{ "modules": ["./register.tsx"] }`. This spike is its own plugin, loaded with
`--plugin-dir spike/mod`, so the shipped `hooks/hooks.json` is untouched. To
ship it, add `"modules"` beside the existing `"hooks"` key of the plugin's
`hooks/hooks.json`. `claude plugin validate` accepts a file with both keys.
Whether both load in one session is untested.

## Not proven here

- `$.ui.ask` answers, which are an AskUserQuestion tool call and may well be
  recorded. A `command.run` answer that returns `text` (documented as read by
  the model). A Pane.
- Whether a compaction summary could pick up any of the transcript-only rows.
- ANSI or OSC 8 in the status line.
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
