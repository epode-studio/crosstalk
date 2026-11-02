# Shipping

How crosstalk takes a feature from "the work is ready" to merged, behind a
flag, ramped and, when production says so, off again, without anyone reading
code. The design is in [next-generation.md](design/next-generation.md),
"Shipping", "Production feeds threads" and "Git is invisible". The code is
`src/shipping/`.

## The path of a feature

| | Everyday | Risky |
|---|---|---|
| Made so by | the default | a path in `.crosstalk/risk`, or an agent (`crosstalk_feature {risk: "risky", why}`) |
| Review | one fresh claude session | an adversarial review on another client or model, plus a security pass |
| Before merge | reviewers sign off, checks pass | the same, plus evidence of behaviour and a person's yes |
| Flag | optional | required (named for it unless the agent names one) |
| After merge | done | each flag step (internal → N% → on) is a question with the evidence from the step before |

1. **Declare.** An agent calls `crosstalk_feature {name}`. The branch is the
   session's. crosstalk reads `.crosstalk/risk` from the default branch, plus
   any paths the branch itself adds (a branch can add risky paths, never take
   them away), and marks the feature risky when the branch touches one.
2. **Ready.** The author calls `crosstalk_ready {feature}`. This explicit call
   is the trigger, not the session going idle: a session goes idle for many
   reasons (a question, a break, a dead end), and only the author knows the
   work is done.
3. **Review.** Each reviewer is a one-shot session (`claude -p`, `codex exec`)
   in a detached copy of the branch, in crosstalk's own tmux
   (`tmux -L crosstalk`, so `show me review-…` attaches) or, with no tmux, a
   detached process. It sees the thread's recap, decisions, facts and answered
   questions (marked as data), the commit range, and earlier rounds' findings
   with the author's answers. Never the author's conversation. It ends with
   `VERDICT: approve|changes` and `FINDINGS:`, and its wrapper hands the answer
   to `crosstalk review --run <id> --output <file>`. A reviewer that has
   crosstalk's tools may call `crosstalk_review` itself. No verdict counts as
   changes; silence is never a sign-off. A reviewer that never answers is
   counted as "changes, nothing reviewed" after two hours.
4. **Iterate.** Findings go to the author's session as a crosstalk message
   (read with `crosstalk_read`, framed as other agents' words). The author
   fixes, commits and calls `crosstalk_ready {feature, response}`. After
   `rounds` rounds (default 3) still asking for changes, people get one
   question: what each side says, and what each option means.
5. **Checks.** The branch is checked out again, detached, dependencies linked
   from the main checkout, and the test command runs there: `test:` in
   `.crosstalk/ship`, else package.json's test script (run by the lockfile's
   package manager), else `make test`, else `pytest -q` for a Python project.
   No command found means nothing to run, and the thread says so.
6. **Evidence** (risky). `crosstalk_evidence {feature, summary, tests?, evals?,
   before_after?, screenshots?, stage?}`: plain language with proof. A diff is
   refused; a risky feature's evidence needs proof beyond the summary;
   screenshot paths must exist. The merge question shows it.
7. **Merge.** See below. Sign-off, checks, the merge and each flag step are
   recorded in the thread as decisions and facts.
8. **Flags.** A risky feature's flag starts off. Each step up is a question
   with the evidence gathered at the step before (`stage` on
   `crosstalk_evidence`); the first step uses the merge evidence. Turning a
   flag off is never a question: any agent may (`crosstalk_flag {stage:
   "off"}`), and the people are told. At `on`, a task in the thread asks an
   agent to remove the flag and the old path.

## Questions are a person's

Lowering a risk, merging a risky feature, each flag step and a
reviewer/author disagreement are asked through the mod's picker (or, without
the mod, a notice) and recorded as blocking thread questions. They are
answered by a person only:

- the picker (`crosstalk ui act`, from the mod), or
- `crosstalk ship answer <id> "<option>"` typed in a terminal.

An agent's `crosstalk_thread {answer}` is refused, `crosstalk ship answer`
run from inside an agent (where `CLAUDECODE` is set) is refused, and no
standing rule answers them. This guards against an agent answering by
accident; it is not a security boundary against code running as you.

## Merging (git is invisible)

`push:` in `.crosstalk/ship`:

| `push:` | What happens |
|---|---|
| `direct` | merged locally, then the default branch is pushed. Fast-forward when possible; otherwise the branch is rebased onto the default branch in a detached scratch copy, so the author's branch and checkout are never rewritten. A local default branch behind its remote is brought up first; one that has diverged is left for a person. |
| `pr` | the branch is pushed, `gh pr create` opens a PR, `gh pr merge --auto --rebase` sets it to merge once checks pass. |
| `local` | merged locally, nothing pushed. |
| not set | `pr` when there is a remote and `gh` is installed, else `local`. |

Never a force push; never a branch other than the feature's own (and, for
`pr` flag changes, a `crosstalk/flags-…` branch of its own). A conflict goes
back to the author's agent. When the default branch is checked out, it moves
with `git merge --ff-only` (which refuses to overwrite uncommitted changes);
otherwise its ref moves only if nobody moved it meanwhile. Once merged, the
author's worktree is offered to src/cleanup.ts, which now also counts a branch
as landed when its commits are in as equivalent patches (after a rebase).

A thread whose features are all merged is marked done; an incident reopens it.

## Reviewer clients

Detected on PATH when the review starts (`CROSSTALK_REVIEW_CLAUDE`,
`CROSSTALK_REVIEW_CODEX` override the binaries):

- **everyday:** `claude -p` (with `--model <reviewer_model>` when set), read-only
  tools only (`Read Grep Glob` and `git log/diff/show`).
- **risky, adversarial:** `codex exec` when codex is installed (and
  `adversarial:` is not `claude`); otherwise `claude -p --model
  <adversarial_model>` (default `opus`, or `sonnet` when
  `CROSSTALK_AUTHOR_MODEL` says the author is an opus model).
- **risky, security pass:** claude, with a security-only brief.

## `.crosstalk/ship`

```
test: bun run test           # the check; found if absent
push: direct                 # direct | pr | local
rounds: 3                    # rounds before people are asked
ramp: internal 10% 50% on    # a risky flag's steps
flags: file                  # file | launchdarkly | posthog | growthbook | statsig
incident_days: 14            # how recent a ship counts for an incident
reviewer_model: sonnet
adversarial_model: opus
adversarial: auto            # auto | codex | claude
test_timeout: 900            # seconds
```

## `.crosstalk/risk`

```
high: src/auth/** migrations/**
risky: *.tf
everyday: src/auth/**/*.test.ts   # exceptions
```

Globs are repo-relative; `**` spans folders; a glob without a slash matches a
file name at any depth. When a person makes a path-risky feature everyday,
the risky paths it touched then are cleared for that feature; a new one makes
it risky again.

## Flags

**The flags file**, `.crosstalk/flags`, for teams with no provider. The app
reads it at deploy, so off takes as long as a deploy:

```
login-v2: internal
new-billing: 10%
```

JSON (`{"login-v2": "internal"}`) is read and written back as JSON. crosstalk
changes it with a commit of that one file on the default branch, made with a
private index (no checkout is touched), pushed or opened as a PR per `push:`.

**Providers**, set with `flags:` and configured from the daemon's environment:

| Provider | Environment | Stages |
|---|---|---|
| LaunchDarkly | `LAUNCHDARKLY_API_TOKEN`, `LAUNCHDARKLY_PROJECT` (default), `LAUNCHDARKLY_ENVIRONMENT` (production), `LAUNCHDARKLY_BASE_URL` | semantic patches: off = targeting off; internal = on, default rule false (your own targets and rules decide who is internal); N% = default rule a rollout; on = default rule true. Boolean flags only; the flag must exist. |
| PostHog | `POSTHOG_PERSONAL_API_KEY`, `POSTHOG_PROJECT_ID`, `POSTHOG_HOST` (us.posthog.com), `POSTHOG_INTERNAL_COHORT` or `POSTHOG_INTERNAL_EMAIL_DOMAIN` | off = inactive; internal = the cohort or domain at 100%; N% = that plus everyone at N%; on = everyone. A missing flag is created, off. |
| GrowthBook, Statsig | | not yet: says so. |

Metrics are not read from any provider yet.

## Production feeds threads

```
crosstalk incident --source sentry --title "500s on /login" \
  --details "TypeError in session.ts:40" [--flag login-v2] [--files a,b] [--sha abc123]
crosstalk incident --json '{"source": "...", "title": "..."}'      # or --stdin
crosstalk incident --link <incident thread> --cause <thread>
```

Also `crosstalk_incident` for agents. A clear cause (one thread, by the flag,
else a merged commit or its prefix, else the most overlap with files merged in
the last `incident_days` days, with no tie) reopens that thread with the
incident as a fact, a task to find the cause, a notice to its people and a
message to its agents. Anything else starts an `incident-…` thread; link it
once the cause is found. **The automatic kill:** an incident naming the flag
of a risky feature turns that flag off at once and says so.

### Wiring alerts to it

There is no hosted endpoint. `scripts/incident-webhook.ts` is a tiny local
server that turns POSTed JSON into `crosstalk incident`:

```
CROSSTALK_INCIDENT_TOKEN=some-secret bun scripts/incident-webhook.ts 8790
```

- **Sentry:** an internal integration (or an alert rule's webhook action)
  pointed at `http://<reachable host>:8790/?token=some-secret`. The event's
  title, culprit, in-app stack frames, release (taken as the sha when it looks
  like one) and a `flag` tag are passed on. Tag events with the flag that was
  on (`Sentry.setTag("flag", "login-v2")`) to get the automatic kill.
- **Anything else** (uptime checks, Grafana, PagerDuty): POST
  `{"title", "details", "flag"?, "files"?, "sha"?}` with `?source=<name>`.

How the port is reached from outside (a tunnel, a VPN, a cron polling your
alerting API and calling `crosstalk incident` directly) is your choice.

## What is local and what is shared

On the feature in the thread, shared with its people and committed to
`refs/crosstalk/threads`: state, branch, why risky, round, sign-offs,
evidence, the merge (sha, commits, files, how), the flag stage. On this
machine only, in `<crosstalk home>/shipping.json`: reviewer runs in flight,
which session is a feature's author, and the questions out.
