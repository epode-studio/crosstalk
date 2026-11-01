# The next generation: topics, not rooms

Status: workshopped, not built. Decisions below come from an interview on
2026-11-01; what is still open is at the end.

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
- **Inference picks the conversation, not the audience.** Working out what a
  session is about may change *which of your sessions* hears something. It
  never pulls in someone you have not verified. The one place it can widen who
  reads a topic is combining two topics (decision 9), and that is announced.
- **Nobody reads code.** People decide what should happen and judge whether it
  did. Agents write the code, and other agents review it (decision 14).

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

| Signal | Source | Cost |
|---|---|---|
| Files touched | `PostToolUse` paths | Free, deterministic, hard to fool |
| Repo and branch | git remote, `HEAD` | Free, a strong prior |
| A recap | a `/recap`-style summary of the session's recent turns | Tokens, so only when needed |

**Files and branch decide most of the time.** A recap is computed at the end of
a turn (Stop) only when the files are ambiguous: two topics both plausible, or
files that suggest a new topic.

Each topic keeps a footprint built from the same signals: its files, branches
and a running recap. A session's match to a topic is the overlap between the
two.

**When it is still unsure**, crosstalk asks once in the likeliest session ("Is
this about your auth work? y/n"). The answer becomes a binding and a signal for
next time.

### 3. Addressing: the topic decides

"Tell marie the token format changed" goes to the topic(s) the current session
follows. Marie's daemon delivers it to *her* sessions that follow the same
topic. Nobody names sessions.

### 4. Joining topics is automatic within trust

When your api session starts an "auth" topic, Marie's session that is working
on auth joins it with no prompt, because you have already verified each other.
Nobody outside your verified set can be pulled into a topic by inference.

### 5. What happens with no matching session

**It asks you.** A question in your active session, through the usual question
routing (decision 8):

```
◢ marie wrote about auth; nothing open follows it.
  resume yesterday's auth session? [y / new / hold]
```

`y` resumes the topic's last session, `new` starts one, `hold` keeps it in the
inbox with a statusline count until a matching session opens.

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
machine only if that peer is at `handoff` or above. For an inbound message with
no matching session, you are asked either way (decision 5).

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

Topics **combine when they turn out to be the same work**: when two footprints
converge, they become one topic, **even if their people differ**. Everyone on
either side then reads both histories. Because that widens who can read what,
the notice says so plainly, to everyone, when it happens:

```
◢ auth and login tokens are now one topic: auth.
  jo can now read what you and marie discussed in auth,
  and marie can read login tokens.
```

### 10. Memory

Both:

- **Per topic**, travelling with the people: facts, tasks and decisions sync
  between members, and a session loads the memory of every topic it follows at
  SessionStart.
- **Per repo**, as the durable record: the topic files (decision 12).

### 11. Migration: clean break

The next generation is a new protocol. Existing rooms are not converted; people
verify each other again with four words. That is what builds the trust layer
the topics sit on.

### 12. Topics are tickets, kept in the repo

Each topic is a file in the repository, a Linear-style tracker that is just a
document. **A topic holds any number of features**, each with its own risk and,
where it has one, its own flag.

```
.crosstalk/topics/auth.md

---
status: active          # active · waiting · done · archived
people: [paul, marie]
sessions: [paul/api, marie/api]
files: [src/auth/**, src/api/tokens.ts]
branches: [token-v2]
features:
  - name: v2 token format
    risk: high
    flag: auth-v2-tokens     # via the flag provider, at internal
  - name: token expiry banner
    risk: normal
    flag: token-expiry-ui    # built-in, at 100%
  - name: tidy token parser
    risk: low                # no flag, shipped on merge
---

## Recap
Moving tokens to v2 format; v1 kept for one release.

## Open questions
- keep the v1 endpoint? (api-worker, blocking)

## Decisions
- 2026-11-01 · paul · v1 tokens accepted until 0.2
```

This is the topic registry that inference matches against (files, branches,
recap). Agents write to it from hooks as they work: the Stop hook updates
status, features, recap and open questions. People read it, or edit it by hand.

**Sealed unless marked public.** A topic file is committed encrypted to the
topic's members, so git still syncs and versions it but only members can read
it, even in a public repo. A topic marked public is committed in plain text.

**Sync: relay live, git on change.** Each update goes to the topic's members at
once over the relay. The file is committed alongside real work only when
status, features, decisions or questions change, not on every recap tweak. That
keeps it fresh without touching every commit.

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
decisions and open questions, linked to the commits made under it. That is
small, and keeps raw prompts out of the repository.

The three claims crosstalk should be able to back with numbers:

| Claim | How to prove it |
|---|---|
| **Fewer tokens** | Agents start from topic memory instead of re-reading the repo. Measure tokens-to-first-useful-edit with and without, on real sessions. |
| **Zero migration** | One plugin command on an existing repo and host. Nothing else to set up. The install test is the proof. |
| **No one can read it** | The relay sees only ciphertext, and topic files are sealed in the repo. A forge has to read your code to host it; crosstalk never holds it. |

Correct routing is not on that list because it is the minimum, not a selling
point. It still needs tests that prove it.

### 14. Fully AI-native: no human reads code

The way we work: **nobody ever reads a line of code.** People decide what should
happen and judge whether it did. Agents write the code, and other agents review
it.

So the PR diff is the wrong thing to put in front of a person, and **the topic
is the trail**: the unit of work from first idea to merge. It can exist before
any branch, produce several PRs across several repos, and stays open until its
questions are resolved and its flags are gone.

**The PR is plumbing.** Agents open it, the checks and the reviewer agent gate
it, and it auto-merges. People never open it. Branch protection on the host
still applies, and is satisfied by checks and the reviewer agent rather than a
person.

#### Risk is per feature, and only ratchets up

A repo file lists risky paths:

```
.crosstalk/risk

high: src/auth/** src/payments/** migrations/**
```

A feature that touches any of them is high risk. The author agent may raise any
feature's risk on its own. **Lowering it is always a question to a person**,
since a feature wrongly marked low is the dangerous mistake.

#### What a person approves, by risk

| Risk | A person approves | Then |
|---|---|---|
| **Low** | Nothing | Merges on green checks and the reviewer agent's sign-off. Shown in the digest afterwards. |
| **Normal** | The intent up front, and the questions agents surface | Agents build against the agreed goal and decisions, and merge once the evidence passes. |
| **High** | The intent up front, the questions, the **evidence of behaviour**, and each step of the flag ramp | As below, plus a higher evidence bar. |

Answering the questions agents surface counts as approval at every level.

**Evidence of behaviour** is a plain-language summary of what changed in
behaviour, with proof: tests added, evals passed, before and after, a demo or
screenshot where there is something to see. It never includes a diff.

#### Who reviews the code

**A different agent session**, started by crosstalk in the topic with fresh
context, so it does not share the author's reasoning. Its findings go back to
the author agent, which fixes them, until the reviewer agrees. A person hears
about it only when the two cannot agree, as a plain-language question: what
they disagree on and what each option means for behaviour.

For **high-risk** features, both of:

- **An adversarial reviewer on a different model or client** (e.g. Codex
  reviewing Claude Code's work, which crosstalk already speaks to), plus a
  dedicated security pass. Both must agree. A fresh session on the same model
  can share the author's blind spots; a different model is less likely to.
- **A higher evidence bar**: property tests or equivalent, and a flagged
  rollout instead of a staging run (decision 15). The flag is the rollback plan.

#### Why this is faster

The slow parts of shipping today are a person reading a diff and waiting for
CI. Here the first is gone, and what is left of human attention goes earlier
and higher:

| Gain | How |
|---|---|
| Wrong approaches caught before code | The approach is agreed in the topic ("v2 tokens, v1 until 0.2"). Agents produce wrong-but-complete code fast, so this is where human judgment does most. |
| People never see work that fails | Author and reviewer agents iterate until tests, evals and review agree. |
| One approval for a change across repos | API + client + docs is one intent, approved once. |
| Questions don't wait for anyone to notice | A blocked agent asks inline in seconds (decision 8). |
| Context comes with every decision | The recap explains why, for people and for the reviewer agent. Also where the token saving comes from. |

**What it does not do:** CI is still compute. Checks run in the session before
a push (only the tests the change affects) so hosted CI confirms rather than
discovers, but a slow suite stays slow.

**The claim:** a person spends their attention on intent and evidence, never
code, measured as time from idea to merge and human minutes per merged topic.

### 15. Feature flags instead of staging

Today a feature ships when it works in main. Putting staging in front of that
is too slow. Flags make "turned on" a separate step from "merged". **Merged
means in main and off. Shipped means on. Rollback is turning the flag off, not
a revert.**

Flags are per feature, and a topic can hold any number of features.

**Which features get a flag:**

| Risk | Flag | Ramp |
|---|---|---|
| **Low** | none | ships on merge |
| **Normal** | optional: the author agent adds one when the change is visible to users | internal, then everyone, automatically if metrics hold |
| **High** | required, **through a flag provider** | each step is a question to a person |

**Where flags live:**

- **Built in**, for normal-risk features and teams with nothing: flag
  definitions *and state* in a repo file next to the topic files, read by the
  app at deploy. Flipping a flag is a commit plus a deploy. No vendor, no new
  runtime dependency, and crosstalk never becomes part of production.
- **Adapters** for a flag provider (LaunchDarkly, PostHog, GrowthBook,
  Statsig), required for high-risk features because their kill switch has to
  be instant, not as fast as a deploy. crosstalk drives the flag and reads its
  metrics.

**What replaces staging as evidence for high-risk features**, all four:

| Step | What happens |
|---|---|
| **Preview per topic** | An ephemeral deploy with the feature's flag on, where agents run end-to-end checks before merge. |
| **Dark launch** | After merge, the new path runs in production next to the old one, invisibly, and agents compare outputs. |
| **Internal first** | On for your own accounts or team. Real use, with agents watching logs. |
| **Auto kill switch** | Throughout the ramp, agents watch errors and latency and turn the flag off through the provider on any regression, before a person notices. |

**Who turns it on:** each ramp step of a high-risk flag (internal, then a
percentage, then everyone) is a question to a person, with the evidence from
the previous step attached. Turning off is never a question: any agent watching
may do it, and tells you after.

A topic stays open while any of its flags exists. Once a flag is at 100%, an
agent removes it and the old path from the code, so flags do not pile up. The
topic closes when its last flag is gone and its questions are answered.

## Still open

These are technical, with a proposed answer each. None needs a product decision
before it is written up properly.

1. **Keys for many topics.** Every topic is its own sealed room and joining is
   automatic, so creating one must cost no exchange. Proposal: derive each
   topic's key from the pairwise keys its members already share, and rotate by
   re-deriving when someone leaves. Combining two topics (decision 9) issues a
   new key to the union of members. Needs a proper write-up in
   `docs/security.md` before anything is built.
2. **What the relay sees.** More topics means more topic ids, and the pattern
   of their creation leaks how much someone multitasks. Proposal: each member
   reaches all their topics over one connection with one id, and topic ids
   appear only inside sealed frames.
3. **Sealed topic files in git.** Encrypted files make useless diffs and
   conflict badly. Proposal: one sealed blob per field (status, features,
   decisions, questions) so concurrent edits to different fields merge, and
   the relay's live copy settles any conflict before anything is committed.
4. **Recaps leaving the machine.** Recaps already travel sealed to topic
   members (decision 12). Proposal: matching runs on each member's machine
   against the shared footprint, so nobody's raw session state leaves their
   machine, only the recap.
