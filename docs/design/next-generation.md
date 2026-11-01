# The next generation: topics, not rooms

Status: workshopped, not built. Decisions below come from an interview on
2026-11-01; open questions are at the end.

## The problem this fixes

A room today belongs to an identity, not to a session. When a message arrives,
`pickSession()` in `src/daemon.ts` delivers it to the session the sender named,
or else to whichever local session Claude Code reports as idle, or else to any
live one, or else to the first one ever registered. Nothing about the message's
subject takes part in that choice.

So with three sessions open, api, firmware and docs, a note about the auth token
format lands in whichever of them happens to be idle. That is the cross-talk:
the right person, the wrong chat.

The second gap is that crosstalk can only talk to sessions you already started.
It cannot start one, reopen one, or bring a question from one into the place you
are looking.

## Principles

- **As native to the code CLI as possible.** No app, no TUI, no web dashboard,
  no tmux requirement. The control surface is plugin + hooks + MCP + one daemon,
  and you drive it in plain language from any session you already have open.
- **Automatic before explicit.** You should almost never have to say which
  topic or session something belongs to. When crosstalk is unsure it asks once,
  and remembers.
- **Inference picks the conversation, never the audience.** Working out what a
  session is about may change *which of your sessions* hears something. It must
  never change *which people* can read it.

## Decisions

### 1. The topic is the room

There are no named rooms any more. Every topic is its own sealed room, created
on demand when a session starts working on something new.

Under the topics there is still a trust layer. It is just not called a room:
it is the set of people whose identity you have verified (four words, crossed
fingerprints, as today). A topic can only ever include people from that set.

### 2. Sessions are bound to topics by inference

A session follows **any number of topics, equally**. Nothing is primary.
Relevance scoring decides how strongly each message matters to each session.

What the inference reads:

| Signal | Source | Why |
|---|---|---|
| Files touched | `PostToolUse` paths | Cheap, deterministic, hard to fool |
| Repo and branch | git remote, `HEAD` | A strong prior that costs nothing |
| A recap | a `/recap`-style summary of the session's recent turns | Catches what the files don't, e.g. "deciding the token format" |

Each topic keeps a footprint built from the same signals: its files, branches
and a running recap. A session's match to a topic is the overlap between the
two.

**When it is unsure** (two sessions both plausible, or something that looks
like a new topic), crosstalk asks once in the likeliest session ("Is this
about your auth work? y/n"). The answer becomes a binding and becomes training
signal for next time.

### 3. Addressing: the topic decides

"Tell marie the token format changed" goes to the topic(s) the current session
follows. Marie's daemon delivers it to *her* sessions that follow the same
topic. Nobody names sessions.

### 4. Joining topics is automatic within trust

When your api session starts an "auth" topic, Marie's session that is working
on auth joins it with no prompt, because you have already verified each other.
Nobody outside your verified set can be pulled into a topic by inference.

### 5. What happens with no matching session

Not settled: either hold it (inbox + statusline "1 for auth") or spawn a
session for it (see 7). The likely answer is: hold by default, and spawn only
when the trust ladder allows it.

### 6. Where you see which topics a session is in

All three of:

- **Statusline**: `◢ auth · tokens   2 peers`
- **SessionStart banner**: one line saying which topics were joined and why
  ("auth: you edited src/auth/*").
- **Session name**: the session's title carries its topics, so `/resume` and the
  session registry show them.

### 7. Spawning and managing sessions

All four are in scope:

| Mode | What it means |
|---|---|
| **Adopt existing** | Discover sessions already running (`~/.claude/sessions`), give them topics, steer them through the existing inject path |
| **Resume dormant** | A topic gets traffic, its last session is closed: wake it with `claude --resume <id>` rather than starting cold |
| **Spawn on arrival** | Nothing fits: start a headless worker (`claude -p` / Agent SDK) in the right repo |
| **Fan out** | "Do these three in parallel": crosstalk starts the workers, puts them in a shared topic, tracks them |

**Order of shipping:** routing to the right *open* session comes first, because
it is the bug people hit today. Resume, spawn and fan-out build on that same
topic matching.

**Autonomy:** a spawned session inherits the trust level of whatever caused it,
and its permission mode follows from that.

**Remote spawn:** a peer's message may start or resume a session on your
machine only if that peer is at `handoff` or above. Below that, it becomes a
question to you.

### 8. Surfacing questions

Every surface exists. Which one a question uses depends on **whether the asker
is blocked, and whether you are present**:

| Asker | You | Surface |
|---|---|---|
| blocked | typing in some session | inline, in that session: `◢ api-worker asks: keep v1 endpoint? [y/n/open]` |
| blocked | away from the terminal | phone push (Claude app / ntfy) |
| not blocked | anywhere | batched digest at the next natural break (Stop hook, idle) |
| any | any | statusline badge with the count, always |

The answer is routed back to the session that asked.

### 9. Topic lifecycle

Topics **fade when quiet**: no traffic and no session following it for N days,
and it archives. Its memory stays searchable, and any new activity revives it.

Topics **merge when they overlap**: when two footprints converge, they merge
and you are told.

### 10. Memory

Both:

- **Per topic**, travelling with the people: facts, tasks and decisions sync
  between members, and a session loads the memory of every topic it follows at
  SessionStart.
- **Per repo**, as the durable record: `DECISIONS.md` and friends stay in the
  repository, with entries tagged by topic.

### 11. Migration: clean break

The next generation is a new protocol. Existing rooms are not converted; people
verify each other again with four words. That is what builds the trust layer
the topics sit on.

### 12. Topics are tickets, kept in the repo

Each topic is a file in the repository, a Linear-style tracker that is just a
document:

```
.crosstalk/topics/auth.md

---
status: active          # active · waiting · done · archived
people: [paul, marie]
sessions: [paul/api, marie/api]
files: [src/auth/**, src/api/tokens.ts]
branches: [token-v2]
---

## Recap
Moving tokens to v2 format; v1 kept for one release.

## Open questions
- keep the v1 endpoint? (api-worker, blocking)

## Decisions
- 2026-11-01 · paul · v1 tokens accepted until 0.2
```

This is the topic registry that inference matches against (files, branches,
recap), and it is readable by any human or agent with no crosstalk installed.
Agents write to it from hooks as they work: the Stop hook updates status,
recap and open questions. People read it, or edit it by hand.

### 13. Positioning: Entire without the forge

[Entire](https://entire.com/) is a hosted Git forge that keeps the *why*
behind code: agent sessions captured as checkpoints linked to commits, Trails
in place of pull requests, a shared memory built from sessions and a code graph,
and search across all of it. To get any of that you move your repositories to
them.

crosstalk makes the same promise without the forge. It lives in the git you
already have, on whatever host, as files in the repository plus a sealed relay.
Nothing to migrate, and nothing hosted that can read your code.

What we capture is **recaps, not transcripts**. Each topic file holds the recap,
decisions and open questions, linked to the commits made under it (in
`.crosstalk/` or git notes). That is small enough to review in a diff and
keeps raw prompts out of the repository.

The three claims crosstalk should be able to back with numbers:

| Claim | How to prove it |
|---|---|
| **Fewer tokens** | Agents start from topic memory instead of re-reading the repo. Measure tokens-to-first-useful-edit with and without, on real sessions. |
| **Zero migration** | One plugin command on an existing repo and host. Nothing else to set up. The install test is the proof. |
| **No one can read it** | The relay sees only ciphertext. A forge has to read your code to host it; crosstalk never holds it. |

Correct routing is not on that list because it is the minimum, not a selling
point. It still needs tests that prove it.

### 14. Why the topic could be the trail: fewer, earlier, smaller reviews

Two ways a topic can meet code review:

- **The topic rides the PR.** Nothing changes for the team. The PR body is
  filled from the topic (recap, decisions, open questions), and review comments
  flow back to the agents on it. Someone without crosstalk reviews as normal.
- **The topic is the trail.** The topic is the unit of work, from first idea to
  merge. It can exist before any branch, produce several PRs across several
  repos, and stays open until its questions are resolved, whatever has merged.
  Decisions are approved in the topic as well as code in the PR.

Ship the first; grow into the second. The topic files exist either way, so
moving later needs no migration.

**The PR is not the bottleneck.** The slow parts are a person reading a diff
and CI running. Neither goes away by renaming the unit of work. What a trail
changes is *when* a person looks and *at what*:

| Gain | How |
|---|---|
| Wrong approaches caught before code | The approach is agreed in the topic ("v2 tokens, v1 until 0.2"), so review is a check that the code matches, not an argument about direction after 800 lines. Agents make this matter more: they produce wrong-but-complete code fast. |
| A person only sees work that passes | Agents iterate on the topic until tests and evals are green, then a person is asked. Nobody reviews a red PR. |
| One approval for a change that spans repos | API + client + docs is one decision approved once, not three reviews. Each PR is checked against it. |
| Questions don't wait for a PR | A blocked agent asks inline in seconds (decision 8), instead of opening a PR and waiting to be noticed. |
| Context comes with the review | Reviewers, human or agent, read the recap instead of reverse-engineering why. Also where the token saving comes from. |

**What it does not do:**

- **CI is still compute.** Checks can run in the session before a push (only
  the tests the change affects), so hosted CI confirms rather than discovers.
  A slow suite is still slow.
- **Skipping review is not a speed-up.** The claim is that people review intent
  and outcomes rather than every line, which fits low-risk changes. A topic can
  be marked as needing line-by-line review (auth, payments, migrations).
- **Branch protection still applies.** Required reviews and status checks on
  the host stay. Topics make satisfying them faster.

**The claim:** fewer, earlier, smaller reviews, measured as time from idea to
merge. That may be a sharper answer to Entire than push throughput.

## Open questions

1. **No-match behaviour** (decision 5): hold or spawn, and whether that depends
   on the sender's trust level.
2. **Key management for many topics.** With every topic its own sealed room and
   joins automatic, the clean answer is to derive each topic's key from the
   pairwise keys of its members, so creating a topic costs no exchange. Kicking
   someone from a topic then means re-deriving without them. This needs a
   proper write-up in `docs/security.md` before anything is built.
3. **What the recap costs.** A `/recap`-style summary means tokens on every
   update. Options: only recompute on Stop, only when files alone are
   ambiguous, or have the agent declare its topic itself through a tool call.
4. **What the relay sees.** More topics means more topic ids on the relay, and
   their creation pattern leaks how much you multitask. Possibly pad or pool
   them.
5. **Merging, a privacy check.** Two topics with different members must never
   merge into one that widens either audience. Merge only if the member sets
   are equal, otherwise suggest a link.
6. **Recaps leaving the machine.** A topic's footprint includes a recap.
   Decide whether the recap stays local (matching happens on each machine) or
   is shared sealed with the topic's members.
7. **How the tracker syncs** (decision 12). Either git carries durable state
   (status changes commit with normal work) while the relay carries only live
   presence and messages, or edits go live through the relay and one member's
   daemon mirrors them to git. The second is fresher but needs a rule for
   which daemon commits, and it must keep secrets in sealed topics out of a
   repo that may be public.
8. **Diff churn.** Agents writing on every Stop will touch files in every
   commit. Possibly keep `.crosstalk/` on its own branch or ref, or only write
   when something actually changed.
9. **When to move from riding the PR to being the trail** (decision 14).
   Likely once a whole team is on crosstalk, since people outside it see only
   the PRs and not the topic connecting them.
10. **Repo-kept recaps vs "no one can read it".** A topic file committed to a
    public repo is readable by everyone, which breaks the third claim for that
    topic. Possibly: topic files are sealed to members unless the topic is
    marked public, or the repo copy keeps only decisions and the recap stays on
    the relay.

