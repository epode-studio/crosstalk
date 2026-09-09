# What an agent pays attention to

How interruption works, and why it works this way. All four pieces below are
built: the trust ladder is `src/trust.ts`, triage is `src/policy.ts`, the budget
lives in the daemon, facts are `src/facts.ts`.

Crosstalk started as messaging between two people's Claude Code sessions. What it
turned into is an identity, a room, and a sealed transport that does not care
which client is on either end. Messaging is one thing that runs on top of that.

Four pieces, because three of them depend on the fourth.

```
        trust ladder            what a source is allowed to do to you
             │
             ▼
      what a source may do      when it is allowed to do it
        │          │
        ▼          ▼
  working set   members who
   in a room    are not people
```

---

## 1. Trust ladder

There is a single level per source, and each level contains the ones below it:

| Level | They may |
|---|---|
| `mute` | nothing reaches you |
| `notify` | put a line on your screen; their words stay behind a tool call |
| `ask` | also ask a question that costs you a turn |
| `handoff` | also hand you a work item with state and files |
| `deliver` | also put their words inside your turn |

Defaults: someone in a room of two with you starts at `ask`. Someone in a shared
room you have no direct channel to starts at `notify` and cannot be raised past
it until you do. A member that is not a person starts at `notify` and can never be raised to
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
also honest about the fact that these permissions are ordered, which the
two-field version it replaced hid.

**What this replaced.** `policy.delivery`, `policy.allowAsk`, the `policy`
command and `policy.json` itself, plus the `strangerInRoom` branch in the daemon. One value, one place.

Both existed side by side for a while, and that had a cost worth recording:
`/crosstalk:mute` went on writing `mutedUntil` into `policy.json` while triage
read `trust.muted`, so muting somebody did nothing at all once `trust.json`
existed. Two dials where one decides is not a smaller change, it is a silent
one.

---

## 2. What a source is, and what it may do

The interruption model already works and is pointed at one source. Generalise it.

There was a flat ceiling of forty interruptions an hour here. It is gone: a
number nobody chose is a worse answer than the trust ladder, which names the
person doing the interrupting. A cap also failed in the wrong direction, holding
the message that mattered because unrelated ones had used the allowance. What
remains is the counting, as a record you can act on.

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
  reached you    12 in the last hour
  marie          18   ●●●●●●●●●
  ci             11   ●●●●●
  jo              2   ●
  held           3 waiting for you to go idle
```

**Local sources need no identity.** A script on your own machine posting to your
own daemon is you talking to yourself, so it needs no room and no key
exchange. That is how CI, a cron, or a long migration plug in:

```
crosstalk post "migration finished, 1.2M rows" --intent fyi
crosstalk post "build failed on main" --intent blocking --source ci
```

Remote sources still join a room, because they are someone else.

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

Every agent gets the set once per session, through the hook that already exists,
on the first event that client can actually carry text on. That is not always
the one called session start: on Kimi it is the first prompt, on Goose it is the
end of a turn. The daemon hands it over once, so it does not matter which event
arrives first.

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
identity, no key exchange, no room. `crosstalk post` covers it, and CI, crons and long
jobs are all this shape.

**A room member** is a real identity that joins and lives in a room: a build
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

## Settled

**A room outlives every session.** An identity is permanent, a room is durable, a
session lasts an afternoon. The room holds the roster and the key on each
member's machine and on the relay, so closing a laptop for a week leaves the room
and its roster untouched. What is sent meanwhile waits on the relay for 24 hours
and is then dropped, so a long absence costs that traffic rather than the room
it belonged to. Presence is the only part that
is per-session, which is why `/crosstalk:peers` shows sessions coming and going
while the room stays. Everything below depends on that: a working set only means
anything because the place holding it outlasts the conversations.

**Trust belongs to the room, with people pinned.** A room carries a loudness that
applies to everyone in it, and a person can be pinned above or below it. Setting
it per person meant eight decisions for a room of eight, and making them again
for the next room. What varies is what a room is for, not who is in it.

**Facts live in the room and carry tags.** Injection filters by where you are, so
a fact tagged with the firmware repo does not load in the web one, and an
untagged fact always applies. Rooms are not repositories, and tags generalise
past repositories to features or decision areas.

**Facts stop being single-authored.** Any member can confirm a fact, which resets
its age and adds their name. A fact Marie wrote and Jo confirmed is Jo's fact
too, so Marie leaving changes nothing about it. Departure only matters for claims
nobody else ever backed, which are exactly the ones to be suspicious of.

Facts are never deleted because an author left, because who wrote a claim and
whether it is true are different questions. Age is the signal shown, not
authorship: "unconfirmed since March" rather than "written by someone who left".
When a member actually leaves, which is the one moment the system observes, the
others are asked once whether to review the claims nobody else confirmed. Anyone
can supersede anything, and superseding records who and why.

Writing to the set needs at least `ask` level, so someone in a shared room you
added to a shared room by somebody else can read facts but not leave any behind.

**Count interruptions, not arrivals.** A message held quietly costs nothing, and
counting it would make the record say something untrue. This argued for a flat
ceiling once the counting was right; the ceiling went anyway, because naming the
person who is interrupting you is a better answer than a number.

**Agents reach other people's agents when a human asks.** Unprompted contact is
one sentence in the skill and worth trying later, bounded on the sending side by
a budget of unprompted messages an hour per peer, each of which must say why it
is relevant. The receiving side needs no change, because the ladder and the
budget already govern what any message can do regardless of who chose to send it.
The failure to watch is not cost, it is an agent that tells you everything, at
which point you stop reading.

**Nothing is spawned anywhere.** Each person runs their own agent on their own
machine, and the relay is a pipe that cannot read what passes through it. A
member that is not a person runs on somebody's hardware and somebody's tokens,
and it is always clear whose.

## Open questions

Nothing outstanding. Everything above was decided in review.
