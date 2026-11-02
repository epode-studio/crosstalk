# Shipping

How crosstalk takes a feature from "the work is ready" to merged, behind a
flag, ramped and, when production says so, off again, without anyone reading
code. The design is in [next-generation.md](design/next-generation.md),
"Shipping", "Production feeds threads" and "Git is invisible". The code is
`src/shipping/`.

## The path of a feature

| | Everyday | Risky |
|---|---|---|
| Made so by | the default | a path in `.crosstalk/risk`, or an agent (`crosstalk_ship {action: "feature", risk: "risky", why}`) |
| Review | one fresh claude session | an adversarial review on another client or model, plus a security pass |
| Before merge | reviewers sign off, checks pass | the same, plus a preview deploy with its flag on (when `preview:` is set), evidence of behaviour and a person's yes |
| Flag | optional | required (named for it unless the agent names one) |
| After merge | done; a flag, when it has one, goes internal, then to everyone by itself once its metrics hold for the dwell | each flag step (dark → internal → N% → on) is a question with the evidence and metrics from the step before |
| Regression | the flag turns off by itself, the thread reopens | the same |

1. **Declare.** An agent calls `crosstalk_ship {action: "feature", name}`. The branch is the
   session's. crosstalk reads `.crosstalk/risk` from the default branch, plus
   any paths the branch itself adds (a branch can add risky paths, never take
   them away), and marks the feature risky when the branch touches one.
2. **Ready.** The author calls `crosstalk_ship {action: "ready", feature}`. This explicit call
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
   to `crosstalk review --run <id> --secret-file <run folder>/secret --output
   <file in the run folder>`. A reviewer that has crosstalk's tools may call
   `crosstalk_ship action "review"` itself, from its own copy. Nobody else can hand in a
   verdict: the run id alone is refused. No verdict counts as changes; silence
   is never a sign-off, and an answer approves only if every `VERDICT:` line
   in it approves. A reviewer that never answers is counted as "changes,
   nothing reviewed" after two hours. A claude reviewer may read files and run
   a few exact git commands (`git log --oneline <base>..HEAD`, `git diff
   <base>...HEAD`, …), nothing else. Reviewers, and the repo's own commands,
   get an allowlisted environment: no flag provider's variables and nothing
   named like a secret (`*_TOKEN`, `*_API_KEY`, `*_SECRET`, …), only a
   reviewer client's own login.

   Only the commit the reviewers were given is checked, previewed and merged.
   A branch that moves after that is reviewed again on the next
   `crosstalk_ship action "ready"`, and past `building` a feature's branch cannot be
   repointed.
4. **Iterate.** Findings go to the author's session as a crosstalk message
   (read with `crosstalk_say action "read"`, framed as other agents' words). The author
   fixes, commits and calls `crosstalk_ship {action: "ready", feature, response}`. After
   `rounds` rounds (default 3) still asking for changes, people get one
   question: what each side says, and what each option means.
5. **Checks.** The branch is checked out again, detached, dependencies linked
   from the main checkout, and the test command runs there: `test:` in
   `.crosstalk/ship`, else package.json's test script (run by the lockfile's
   package manager), else `make test`, else `pytest -q` for a Python project.
   No command found means nothing to run, and the thread says so.
6. **Preview** (risky, when `preview:` is set). See "Preview per thread" below:
   the branch is deployed with its flag forced on, checked there, and the
   result is evidence.
7. **Evidence** (risky). `crosstalk_ship {action: "evidence", feature, summary, tests?, evals?,
   before_after?, screenshots?, stage?}`: plain language with proof. A diff is
   refused; a risky feature's evidence needs proof beyond the summary;
   screenshot paths must exist. The merge question shows it.
   **Screenshots come by themselves**: the thread's local servers and previews
   are captured after each turn that edits files ([urls.md](urls.md),
   "Screenshots as evidence"), and each URL's latest before and after is added
   to the `screenshots` of every piece of evidence for a feature in that thread,
   beside any the agent names. They count as the proof a risky feature needs.
   What is attached is the path on this machine, never the image: in a sealed
   thread its people see the paths, and no image goes over the relay. Not in a
   public thread, and not with `screenshots: off` in `.crosstalk/ship`.
8. **Merge.** See below. Sign-off, checks, the merge and each flag step are
   recorded in the thread as decisions and facts.
9. **Flags.** A risky feature's flag starts off, and its ramp is `dark
   internal 10% 50% on` unless `ramp:` says otherwise. Each step up is a
   question with the evidence gathered at the step before (`stage` on
   `crosstalk_ship action "evidence"`, or the metrics crosstalk read itself once the step
   has held for the dwell); the first step uses the merge evidence and the
   preview. An everyday feature with a flag goes to internal on merge and to
   everyone by itself once its metrics hold (see "Metrics" below). Turning a
   flag off is never a question: any agent may (`crosstalk_ship {action: "flag", stage:
   "off"}`), crosstalk does it by itself on a regression, and the people are
   told. At `on`, a task in the thread asks an agent to remove the flag and
   the old path.

## Questions are a person's

Lowering a risk, merging a risky feature, each flag step and a
reviewer/author disagreement are asked through the mod's picker (or, without
the mod, a notice) and recorded as blocking thread questions. They are
answered by a person only:

- the picker (`crosstalk ui act`, from the mod), or
- `crosstalk ship answer <id> "<option>"` typed in a terminal.

An agent's `crosstalk_thread {answer}` is refused, `crosstalk ship answer`
and `crosstalk ui act` on a shipping picker run from inside an agent (where
`CLAUDECODE` is set) are refused, and no standing rule answers them. This
guards against an agent answering by accident; it is not a security boundary
against code running as you.

The first question in each repository is whether crosstalk may run its
commands at all: `test:` (or the test script it finds), `preview:`,
`preview_check:`, `preview_teardown:` and `metrics:`. They run unsandboxed,
as you, so nothing of a repository's runs until a person at this machine says
"Run them" (never a person on another machine). The yes is kept for that
repository and that set of commands; a changed `.crosstalk/ship` is asked again.

Lowering a risk is only ever this question too. A feature's `risk` written as
"everyday" by an edit (`crosstalk_thread`, another spelling of its name, a
remove and re-add, a peer's replica) does not count: once crosstalk has seen a
feature risky, it stays risky until a person's answer clears it.

### From another person's machine

A shipping question is asked by the machine running the feature, and it is
also a thread item, so it reaches everyone in the thread like any other
item (over the relay, sealed pairwise; on the ref, sealed to the thread's
people). The item carries the options and which machine asked. On another
person's machine it shows in `crosstalk ship questions` (marked
`elsewhere`) and as a picker in their sessions in that thread, and they
answer it the same two ways: the picker, or `crosstalk ship answer <id>
"<option>"` typed in a terminal (refused from inside an agent, as at home).

Their daemon writes the pick onto the item as a vote signed with their
identity key (src/shipping/remote.ts). The asking machine takes it only when
the signature is good under the key of someone it trusts (a direct peer or
one trusted through the repository), who is a person (a peer marked as a
machine never answers these), who is in the thread, for one of the
question's options. Anything else is not taken, the thread is told why,
and the question keeps waiting. An `answer` written straight onto the item,
by an agent's `crosstalk_thread` or a standing rule on any machine, answers
nothing: only a signed vote does, and rules skip shipping questions.

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
ramp: dark internal 10% 50% on   # a risky flag's steps
everyday_ramp: internal on   # an everyday flag's steps, taken by themselves
flags: unleash               # unleash | launchdarkly | posthog | growthbook | statsig | file
incident_days: 14            # how recent a ship counts for an incident
reviewer_model: sonnet
adversarial_model: opus
adversarial: auto            # auto | codex | claude
test_timeout: 900            # seconds
preview: vercel deploy --prebuilt     # a risky branch's preview, its flag forced on
preview_check: npx playwright test    # run against $PREVIEW_URL
preview_teardown: vercel rm {url} --yes
preview_timeout: 900         # seconds, each
metrics: ./scripts/flag-metrics.sh    # prints JSON numbers for $CROSSTALK_FLAG
regress: errors:+50% latency_p95:+20% shadow_mismatch_rate:>0.01
dwell: 1h                    # how long metrics must hold before the next step
shadow: .crosstalk/shadow    # a folder of <flag>.json shadow counters
screenshots: off             # no screenshots of this repo's servers, and none attached (docs/urls.md)
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
search-v2: dark
```

JSON (`{"login-v2": "internal"}`) is read and written back as JSON. crosstalk
changes it with a commit of that one file on the default branch, made with a
private index (no checkout is touched), pushed or opened as a PR per `push:`.

**Stages:** `off`; `dark` (the new path runs in shadow for everyone, its
results thrown away, mismatches reported; see "Dark launch"); `internal`
(your own accounts); `N%` (your own accounts plus N% of everyone); `on`.

**Providers**, set with `flags:` and configured from the daemon's environment:

| Provider | Environment | Who "internal" is | Stages |
|---|---|---|---|
| Unleash (first-class) | `UNLEASH_URL` (self-hosted or Unleash Cloud, e.g. `https://eu.app.unleash-hosted.com/<instance>`; a trailing `/api` is fine), `UNLEASH_ADMIN_TOKEN` (an admin or personal access token), `UNLEASH_PROJECT` (default), `UNLEASH_ENVIRONMENT` (production), `UNLEASH_INTERNAL_SEGMENT` (a segment id) or `UNLEASH_INTERNAL_CONSTRAINT` (e.g. `email ENDS_WITH @company.com`: field, Unleash operator, values comma-separated; `ENDS_WITH`, `STARTS_WITH`, `CONTAINS` mean the `STR_` ones), `UNLEASH_STICKINESS` (default) | the segment, or the constraint | Admin API (v5+): strategies on the environment, only those titled "crosstalk: …" touched. off = the environment disabled (the instant kill); dark = enabled, a `flexibleRollout` 100% carrying a variant named `dark` (payload `crosstalk-stage=dark`); internal = `flexibleRollout` 100% on the segment or constraint; N% = that plus `flexibleRollout` N; on = `flexibleRollout` 100% for everyone (the default strategy). A missing toggle is created (type release), off. Metrics: exposures (`exposures_yes`, `exposures_no`, `exposures`) from `/api/admin/client-metrics/features/:name`, the last hour in the environment. |
| LaunchDarkly | `LAUNCHDARKLY_API_TOKEN`, `LAUNCHDARKLY_PROJECT` (default), `LAUNCHDARKLY_ENVIRONMENT` (production), `LAUNCHDARKLY_BASE_URL`, `LAUNCHDARKLY_INTERNAL_SEGMENT`, `LAUNCHDARKLY_METRICS` | with `LAUNCHDARKLY_INTERNAL_SEGMENT`, that segment: crosstalk adds one rule, "crosstalk: internal", the segment → true. Without it, the flag's own individual targets and rules you set up | semantic patches: off = targeting off; internal = on, default rule false; N% = the internal rule plus a default-rule rollout; on = default rule true. Boolean flags only; the flag must exist. |
| PostHog | `POSTHOG_PERSONAL_API_KEY`, `POSTHOG_PROJECT_ID`, `POSTHOG_HOST` (us.posthog.com), `POSTHOG_INTERNAL_COHORT` or `POSTHOG_INTERNAL_EMAIL_DOMAIN` | the cohort, or persons whose email contains `@<domain>` | off = inactive; internal = that condition at 100%; N% = that plus everyone at N%; on = everyone. A missing flag is created, off. |
| GrowthBook | `GROWTHBOOK_API_KEY`, `GROWTHBOOK_API_HOST` (api.growthbook.io), `GROWTHBOOK_ENVIRONMENT` (production), `GROWTHBOOK_PROJECT`, `GROWTHBOOK_OWNER`, `GROWTHBOOK_INTERNAL_CONDITION` (a JSON targeting condition) or `GROWTHBOOK_INTERNAL_EMAIL_DOMAIN`, `GROWTHBOOK_HASH_ATTRIBUTE` (id) | the condition, or `{"email": {"$regex": "@<domain>$"}}` | the environment's rules (REST API v1, `POST /api/v1/features/:id`): off = environment disabled; internal = a force rule, the condition → true; N% = that plus a rollout rule, true at coverage N/100; on = a force rule, true for everyone. Default value false. Only rules described "crosstalk: …" are touched; yours stay first. A missing feature is created (boolean, off). |
| Statsig | `STATSIG_CONSOLE_API_KEY`, `STATSIG_API_URL` (statsigapi.net/console/v1), `STATSIG_INTERNAL_SEGMENT` or `STATSIG_INTERNAL_EMAIL_DOMAIN`, `STATSIG_ENVIRONMENT` | the segment (`passes_segment`), or emails containing `@<domain>` | the gate's rules (Console API, `PATCH /gates/:id`): off = `isEnabled: false`; internal = a rule, the internal condition at 100%; N% = that plus a public rule at passPercentage N; on = a public rule at 100%. Only rules named "crosstalk: …" are touched. A missing gate is created, disabled. |
| the flags file | none | the app decides: the helper's `user.internal` (below) | written as the value itself, `dark` included |

**Dark in Unleash** is the variant: at `dark` the toggle is enabled, so an app
must look at the variant before `isEnabled()`: `getVariant(name).name ===
"dark"` means run the new path in shadow and keep the old one's result (pass
that to the helper as `stage`, below).

**Dark on the other providers:** a boolean flag has no third value, so `dark` is the
flag itself off (nobody gets the new path's result) and a companion flag,
`<flag>-dark`, on for everyone (the app runs the new path in shadow). PostHog,
GrowthBook and Statsig get the companion created when it is missing; in
LaunchDarkly create a boolean flag `<flag>-dark` once. Every later stage turns
the companion off.

## Preview per thread

A risky feature's branch is deployed before it merges, with its flag forced
on, and checked there:

```
preview: vercel deploy --prebuilt          # or: fly deploy --app shop-pr-{branch}, or any script
preview_check: npx playwright test         # gets PREVIEW_URL
preview_teardown: vercel rm {url} --yes    # once merged
```

After the reviewers sign off and the checks pass, the preview runs in a
detached copy of the branch (dependencies linked from the main checkout) with
`CROSSTALK_FLAGS=<flag>=on`, `CROSSTALK_BRANCH`, `CROSSTALK_FEATURE`, and
`{branch}` in the command replaced by the branch made safe for a hostname
(`crosstalk/login-v2` → `crosstalk-login-v2`). The URL is the last http(s)
URL it printed, or a line `PREVIEW_URL=<url>`. `preview_check` then runs in
the same copy with `PREVIEW_URL` set. Both passing, the result is evidence
(stage `preview`: the URL, and the check's last lines), shown in the merge
question and the first flag step's question beside the author's own; the
author's agent can use the URL for screenshots. A failure goes back to the
author like a red check. Once merged, `preview_teardown` runs in the main
checkout with `PREVIEW_URL` and `{url}`. A new commit gets a new preview.

## Dark launch

At `dark` the app runs both paths for everyone, answers with the old one, and
reports whether the new one agreed. The helpers below read a flag's stage
(`CROSSTALK_FLAGS` first, so a preview's forced flag wins, then the flags
file, or whatever your provider's SDK said, passed as `stage`), and report a
mismatch two ways, either of which crosstalk counts:

- to `crosstalk incident --source shadow --flag <flag> --title ... --details
  "calls=N mismatches=M"`, here through the local webhook
  (`CROSSTALK_SHADOW_WEBHOOK=http://host:8790/?token=…&source=shadow`, see
  "Wiring alerts to it"), or the command itself where crosstalk is installed;
- a counter file `<dir>/<flag>.json` (`{"calls": N, "mismatches": M}`) when
  `CROSSTALK_SHADOW_DIR` is set in the app, read by crosstalk from `shadow:`
  in `.crosstalk/ship` (or its own `CROSSTALK_SHADOW_DIR`).

A shadow report is never a kill and never reopens a thread: the shadow's
results are not used, so a mismatch hurts nobody. Counts start again each time
a flag goes dark. They become metrics (`shadow_calls`, `shadow_mismatches`,
`shadow_mismatch_rate`): evidence for the step out of dark, and held to the
`shadow_mismatch_rate` rule in `regress:` (default `>0.01`). Over it, the flag
stays dark and the author's agent is told; under it, after the dwell, the step
to internal is asked with the rate attached.

**JS/TS** (`crosstalk-flags.ts`, copy it into your app):

<!-- crosstalk-flags.ts -->
```ts
// crosstalk-flags: is a flag on for this user, and dark launches.
import fs from "node:fs"
import path from "node:path"
import { execFile } from "node:child_process"

export type User = { internal?: boolean; bucket?: number } // bucket: a stable 0..99 per user

/** off | dark | internal | N% | on: CROSSTALK_FLAGS first, then the flags file. */
export function stage(flag: string, file = process.env.CROSSTALK_FLAGS_FILE ?? ".crosstalk/flags"): string {
  for (const kv of (process.env.CROSSTALK_FLAGS ?? "").split(",")) {
    const [k, v] = kv.split("=")
    if (k?.trim() === flag) return (v ?? "on").trim()
  }
  try {
    const text = fs.readFileSync(file, "utf8")
    if (text.trim().startsWith("{")) return String(JSON.parse(text)[flag] ?? "off")
    for (const line of text.split("\n")) {
      const m = /^\s*([^:#=\s]+)\s*[:=]\s*(\S+)/.exec(line)
      if (m && m[1] === flag) return m[2]
    }
  } catch {}
  return "off"
}

/** Whether this user gets the new path. */
export function isOn(flag: string, user: User = {}, s = stage(flag)): boolean {
  if (s === "on") return true
  if (s === "internal") return !!user.internal
  const pct = /^(\d+(?:\.\d+)?)%$/.exec(s)
  return !!pct && (!!user.internal || (user.bucket ?? 100) < Number(pct[1]))
}

const counts: Record<string, { calls: number; mismatches: number }> = {}

function report(flag: string, title: string) {
  const c = counts[flag]
  const details = `calls=${c.calls} mismatches=${c.mismatches}`
  const dir = process.env.CROSSTALK_SHADOW_DIR
  if (dir) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${flag}.json`), JSON.stringify(c))
  }
  const hook = process.env.CROSSTALK_SHADOW_WEBHOOK
  if (hook) fetch(hook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, details, flag }) }).catch(() => {})
  else if (process.env.CROSSTALK_SHADOW_COMMAND === "1")
    execFile("crosstalk", ["incident", "--source", "shadow", "--flag", flag, "--title", title, "--details", details], () => {})
}

/**
 * The flagged code path. On for this user: the new one. Dark: both run, the
 * old one answers, and a mismatch (or the new one throwing) is reported.
 * Otherwise: the old one.
 */
export async function flagged<T>(
  flag: string,
  paths: { old: () => T | Promise<T>; new: () => T | Promise<T> },
  o: { user?: User; stage?: string; same?: (a: T, b: T) => boolean } = {},
): Promise<T> {
  const s = o.stage ?? stage(flag)
  if (isOn(flag, o.user, s)) return paths.new()
  if (s !== "dark") return paths.old()
  const old = await paths.old()
  const c = (counts[flag] ??= { calls: 0, mismatches: 0 })
  c.calls++
  try {
    const shadow = await paths.new()
    if ((o.same ?? ((a, b) => JSON.stringify(a) === JSON.stringify(b)))(old, shadow)) {
      if (process.env.CROSSTALK_SHADOW_DIR && c.calls % 100 === 0) report(flag, `${flag}: shadow agreed`)
      return old
    }
    c.mismatches++
    report(flag, `${flag}: the shadow's result differs`)
  } catch (e) {
    c.mismatches++
    report(flag, `${flag}: the shadow threw ${(e as Error)?.message ?? e}`)
  }
  return old
}
```
<!-- /crosstalk-flags.ts -->

```ts
const total = await flagged("pricing-v2", { old: () => priceV1(cart), new: () => priceV2(cart) }, { user: { internal: user.email.endsWith("@shop.test"), bucket: hash(user.id) % 100 } })
// With Unleash: stage: unleash.getVariant("pricing-v2").name === "dark" ? "dark" : unleash.isEnabled("pricing-v2", ctx) ? "on" : "off"
// With another provider: stage: ld.variation("pricing-v2") ? "on" : ld.variation("pricing-v2-dark") ? "dark" : "off"
```

**Python** (`crosstalk_flags.py`):

<!-- crosstalk_flags.py -->
```python
# crosstalk-flags: is a flag on for this user, and dark launches.
import json, os, re, subprocess, threading, urllib.request

def stage(flag, file=os.environ.get("CROSSTALK_FLAGS_FILE", ".crosstalk/flags")):
    for kv in os.environ.get("CROSSTALK_FLAGS", "").split(","):
        k, _, v = kv.partition("=")
        if k.strip() == flag:
            return (v or "on").strip()
    try:
        text = open(file).read()
        if text.strip().startswith("{"):
            return str(json.loads(text).get(flag, "off"))
        for line in text.splitlines():
            m = re.match(r"^\s*([^:#=\s]+)\s*[:=]\s*(\S+)", line)
            if m and m.group(1) == flag:
                return m.group(2)
    except OSError:
        pass
    return "off"

def is_on(flag, internal=False, bucket=100, s=None):
    s = s or stage(flag)
    if s == "on":
        return True
    if s == "internal":
        return internal
    m = re.match(r"^(\d+(?:\.\d+)?)%$", s)
    return bool(m) and (internal or bucket < float(m.group(1)))

_counts = {}

def _report(flag, title):
    c = _counts[flag]
    details = f"calls={c['calls']} mismatches={c['mismatches']}"
    d = os.environ.get("CROSSTALK_SHADOW_DIR")
    if d:
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, f"{flag}.json"), "w") as f:
            json.dump(c, f)
    hook = os.environ.get("CROSSTALK_SHADOW_WEBHOOK")
    if hook:
        body = json.dumps({"title": title, "details": details, "flag": flag}).encode()
        req = urllib.request.Request(hook, body, {"Content-Type": "application/json"})
        def send():
            try:
                urllib.request.urlopen(req, timeout=5).close()
            except Exception:
                pass
        threading.Thread(target=send, daemon=True).start()
    elif os.environ.get("CROSSTALK_SHADOW_COMMAND") == "1":
        subprocess.Popen(["crosstalk", "incident", "--source", "shadow", "--flag", flag, "--title", title, "--details", details])

def flagged(flag, old, new, internal=False, bucket=100, s=None, same=lambda a, b: a == b):
    """On: new(). Dark: both run, old() answers, a mismatch is reported. Otherwise old()."""
    s = s or stage(flag)
    if is_on(flag, internal, bucket, s):
        return new()
    if s != "dark":
        return old()
    result = old()
    c = _counts.setdefault(flag, {"calls": 0, "mismatches": 0})
    c["calls"] += 1
    try:
        if same(result, new()):
            return result
        c["mismatches"] += 1
        _report(flag, f"{flag}: the shadow's result differs")
    except Exception as e:
        c["mismatches"] += 1
        _report(flag, f"{flag}: the shadow threw {e}")
    return result
```
<!-- /crosstalk_flags.py -->

## Metrics, the watch, and the automatic kill

A flag's metrics come from, first that answers:

- `metrics: <command>` in `.crosstalk/ship`, run in the main checkout with
  `CROSSTALK_FLAG` and `CROSSTALK_STAGE` set. It prints one JSON object of
  numbers, e.g. `{"errors": 3, "latency_p95": 120, "signups": 41}` (the last
  such object it prints counts; `{"metrics": {...}}` works too). Query your
  APM, your error tracker or your warehouse there.
- the provider's own, as well: Unleash's exposures (how many evaluations said
  yes and no in the last hour; data for the question, never judged by `*`, as
  more exposure is the point of a step), and LaunchDarkly, with `LAUNCHDARKLY_METRICS=errors,signup`
  (metric keys), from its experimentation results for the flag's true
  variation (conversion rate when there is one, else the mean value). PostHog,
  GrowthBook and Statsig have none here. The command's numbers win a name
  clash; use it for errors and latency.

plus the shadow counts of a dark flag.

**Baseline:** just before each step up, the metrics are read and kept as the
step's baseline (recorded in the thread as a fact).

**The watch:** the daemon goes over every flag that is ramping (not off, not
on) every five minutes (`CROSSTALK_RAMP_POLL_MS`; `crosstalk ship watch` runs a
pass now) and compares its metrics with the baseline by `regress:`, a list of
rules: `name:+N%` (rose more than N%), `name:-N%` (fell more than N%, for
things where more is better), `name:>X` (above X whatever the baseline; `>N%`
is N/100). `*` covers every metric without a rule of its own (default
`*:+50% shadow_mismatch_rate:>0.01`). A metric that was 0 regresses when it
rises above 1.

- **Regression** (any rule but a shadow one broken): the flag is turned off at
  once, the thread is reopened with the numbers as a fact and a task to find
  out why, its people are told, its agents get the numbers as data, and any
  ramp question is withdrawn. No question first: turning off never is one.
- **Held for the dwell** (`dwell:`, default 1h, since the flag got to this
  stage): an **everyday** flag takes its next `everyday_ramp:` step by itself
  (default internal → on) and the people are told; a **risky** flag's next
  step is asked, with the metrics recorded as evidence at that stage, so the
  question carries them. Without any metrics, an everyday flag stays where it
  is and the author's agent is told once to turn it up with `crosstalk_ship action "flag"`; a
  risky one waits for evidence from the author as before. An everyday flag
  also holds when there is nothing to compare: no baseline from before the
  step, a metric that stopped being reported, or a `metrics:` command that
  failed.

## Production feeds threads

```
crosstalk incident --source sentry --title "500s on /login" \
  --details "TypeError in session.ts:40" [--flag login-v2] [--files a,b] [--sha abc123]
crosstalk incident --json '{"source": "...", "title": "..."}'      # or --stdin
crosstalk incident --link <incident thread> --cause <thread>
```

Also `crosstalk_ship action "incident"` for agents. A clear cause (one thread, by the flag,
else a merged commit or its prefix, else the most overlap with files merged in
the last `incident_days` days, with no tie) reopens that thread with the
incident as a fact, a task to find the cause, a notice to its people and a
message to its agents. Anything else starts an `incident-…` thread; link it
once the cause is found. **The automatic kill:** an incident naming the flag
of a risky feature turns that flag off at once and says so (and a flag whose
metrics regress turns off by itself, above). An incident from source `shadow`
is a dark launch's mismatch: counted, never a kill, never a reopened thread.

### Wiring alerts to it

There is no hosted endpoint. `scripts/incident-webhook.ts` is a tiny local
server that turns POSTed JSON into `crosstalk incident`:

```
CROSSTALK_INCIDENT_TOKEN=some-secret bun scripts/incident-webhook.ts 8790
```

It does not start without the token, every request must carry it (`?token=`
or an `x-crosstalk-token` header), and a request a browser sent (one with an
`Origin` header) is refused.

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
evidence (the preview's and the metrics' included), the merge (sha, commits,
files, how), the flag stage, the preview (URL, whether it passed and is
down), the metrics at the last event (a step's baseline, a kill), and each
shipping question with its options and, from another machine, a signed vote.
On this machine only, in `<crosstalk home>/shipping.json`: reviewer runs in
flight, which session is a feature's author, the questions out, the watch
over ramping flags (stage, since, baseline, the last poll's metrics, so a
poll every few minutes is not a commit), shadow counts, and votes not taken.

## What needs a real account

Everything above is tested against local mocks or local git. Not yet run
against the real services: Unleash's Admin API (written to the v5/v6
project-scoped endpoints: `/api/admin/projects/:project/features/:name`,
`…/environments/:env/on|off`, `…/environments/:env/strategies[/:id]`, and
`/api/admin/client-metrics/features/:name`), GrowthBook's and Statsig's REST APIs (the request
shapes follow their published v1 / Console v1 APIs), LaunchDarkly's
`addRule` with a segment clause and its experimentation results endpoint
(a beta API, whose response shape may differ), and real preview hosts
(Vercel, Fly) behind `preview:`.
