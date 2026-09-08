# Design: what an agent pays attention to

Status: draft for argument, nothing built yet.

Crosstalk started as messaging between two people's Claude Code sessions. What it
turned into is an identity, a room, and a sealed transport that does not care
which client is on either end. Messaging is one thing that runs on top of that.

This designs four pieces at once, because three of them depend on the fourth.

```
        trust ladder            what a source is allowed to do to you
             │
             ▼
      attention budget          when it is allowed to do it
        │          │
        ▼          ▼
  working set   members who
   in a room    are not people
```

---

## 1. Trust ladder

Today a peer has `delivery` (notify, deliver, quiet) and `allowAsk` (on, off),
and someone sharing a room you never paired with is a special case in the code.
Three concepts describing one thing.

Replace all of it with a single level per source, where each level contains the
ones below it:

| Level | They may |
|---|---|
| `mute` | nothing reaches you |
| `notify` | put a line on your screen; their words stay behind a tool call |
| `ask` | also ask a question that costs you a turn |
| `handoff` | also hand you a work item with state and files |
| `deliver` | also put their words inside your turn |

Defaults: someone you paired with starts at `ask`. Someone in a shared room you
have never paired with starts at `notify` and cannot be raised past it until you
pair. A member that is not a person starts at `notify` and can never be raised to
`deliver` at all.

Set globally per person, with an optional override per room, because the same
colleague can be worth interrupting for in `#incident` and not in `#ideas`.

```
/crosstalk:trust marie ask
/crosstalk:trust marie deliver --in incident
/crosstalk:trust ci notify
```

**Why a ladder rather than flags.** A room of eight is unusable if trust is
binary: either everyone can interrupt you or the room is a mailbox. A ladder is
also honest about the fact that these permissions are ordered, which the current
two-field version hides.

**What this replaces.** `policy.delivery`, `policy.allowAsk`, and the
`strangerInRoom` branch in the daemon. One value, one place.

---

## 2. Attention budget

The interruption model already works and is pointed at one source. Generalise it.

A **source** is anything with an identity: a person, a bot, a webhook adapter, a
script on your own machine. Everything inbound carries a source, an intent
(`fyi`, `question`, `blocking`) and a kind.

What happens is a function of three things, none of which the sender fully
controls:

```
trust level (yours)  ×  intent (theirs)  ×  your session state  →  action
```

Escalation stays downward-safe: an intent can lift a held message to a notice and
can never lift a notice into your turn. Only your trust level does that.

On top, a ceiling. Today it is 40 notices an hour across everyone, hardcoded.
Make it configurable, make it visible, and make it per-source as well as total:

```
/crosstalk:attention

  today          31 notices, 4 questions, 1 handoff
  budget         40 / hour, 12 used in the last hour
  marie          18   ●●●●●●●●●
  ci             11   ●●●●●
  jo              2   ●
  held           3 waiting for you to go idle
```

**Local sources need no identity.** A script on your own machine posting to your
own daemon is you talking to yourself, so it needs no pairing and no key
exchange. That is how CI, a cron, or a long migration plug in:

```
crosstalk post "migration finished, 1.2M rows" --intent fyi
crosstalk post "build failed on main" --intent blocking --source ci
```

Remote sources still pair, because they are someone else.

**Why this is the real product.** Every agentic tool has this problem and none of
them have an answer. Notifications arrive with no notion of whether now is a good
moment, so people drown or turn everything off. Peer messaging becomes the first
source plugged into something more general.

---

## 3. The working set

A room that carries messages is a chat. A room that carries a **working set** is
the thing that stops two people re-explaining the same facts every session.

A fact is small, attributed and durable:

```json
{ "id": "f_8a3c", "text": "The API returns snake_case, not camelCase.",
  "by": "marie", "at": 1788860000, "supersedes": null }
```

Facts sync through the room as sealed envelopes like everything else: `fact.add`,
`fact.supersede`, `fact.remove`. Conflicts resolve by id with the author
recorded, so two people editing the same fact produces a visible supersede rather
than a silent overwrite.

Both agents read the set at `SessionStart` through the hook that already exists,
which injects it as additional context on Claude Code and Codex alike.

```
/crosstalk:facts                        what the room holds
/crosstalk:facts add "..."              from the terminal
crosstalk_remember / crosstalk_facts    from the agent
```

**The discipline this needs.** Injecting shared text into a session at startup is
a prompt injection surface by construction. Three rules make it survivable:

1. Every fact is attributed to a person, always, in the injected block.
2. The block says plainly that these are claims by named people, not
   instructions, and that acting on one still needs your user.
3. The digest is capped, newest and most-referenced first, and anything longer
   is fetched by tool call rather than pushed.

**Why this over a shared file in the repo.** A file is a pull request away from
being current, is invisible to the other person's agent until they pull, and has
no author per line. This is live, attributed, and arrives without anyone
remembering to look.

---

## 4. Members who are not people

An identity does not have to belong to a human. Two shapes, and they differ in
whether they cross a machine boundary.

**A local source** is a script on your machine posting to your own daemon. No
identity, no pairing, no room. `crosstalk post` covers it, and CI, crons and long
jobs are all this shape.

**A room member** is a real identity that pairs and lives in a room: a build
watcher everyone sees, or a headless worker that knows the codebase and answers
questions in the room. It runs the daemon and nothing else, no client at all.

Its offer carries `kind: "agent"`, and that has consequences: it starts at
`notify`, it can never be raised to `deliver`, and `/crosstalk:peers` shows it as
a machine rather than a person so nobody mistakes its output for a colleague's.

**Why this matters beyond convenience.** It is the proof that the identity model
generalises, and it gives a room a reason to exist while everyone is asleep.

---

## What this is not

**None of it grants permission to act.** A handoff carries a task, never
authority. A fact is a claim, never a directive. A bot can produce a notice and
nothing more. Every one of these is a new way for something to reach you, and the
reason it stays safe is that the answer to "who decides" never changes.

**Permission relay across people remains out**, for the same reason it always
was.

---

## Order

The ladder first, because the other three are expressed in terms of it. The
budget second, because it is where sources other than people first appear. Then
the working set and non-human members, which are independent of each other.

## Open questions

- Should a trust level be per room by default rather than per person, given the
  same colleague is worth different things in different rooms?
- Does the working set belong to a room, or to a repository? A pair working on
  two codebases probably wants two sets, and rooms are not repositories.
- Should the budget be per hour, or should it adapt to how long a session has
  been idle? A ceiling that never moves is easy to explain and slightly wrong.
- What happens to a fact when the person who wrote it leaves the room?
