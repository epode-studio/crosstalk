# URLs: what people review

Nobody reads code, so the running thing is what a person looks at
([the design](design/next-generation.md), "URLs are what people review").
crosstalk keeps every URL a thread has, labels it, checks that it still
answers, and gives local servers names instead of ports.

Code: `src/urls/`. Tests: `test/urls.test.ts`, `test/urls.sh`.

## 1. Every URL is collected and labelled

One record per thing to look at, in `<crosstalk home>/urls.json`:

| Kind | Where it comes from | Label |
|---|---|---|
| `local` | a crosstalk service's port (`crosstalk_serve`, [services.md](services.md)), kept current as the port moves | `auth · dev server`, `auth · web` |
| `local` | a localhost URL a Bash command printed (`localhost`, `127.0.0.1`, `::1`, `0.0.0.0`, `*.localhost`) | `auth · :5173` |
| `preview` | shipping's preview of a feature (`src/shipping/engine.ts`), one per thread and feature | `auth · preview` |
| `pr` | the PR shipping opened, or a GitHub PR URL a command printed | `auth · PR #12` |
| `link` | any other link a Bash command printed | `auth · acme.dev/cb` |

The label starts with the thread's name, else the worktree's folder name. A
record carries its thread, the session that printed it, its worktree, its
service, when it was first and last seen, last answered and last checked, and
whether it is alive.

**From command output.** At PostToolUse, after a Bash call, the hook
(`src/hook.ts`, no room needed) reads the call's output for http(s) URLs:

- at most ten from one call, each at most 400 characters, no repeats
- **noise is left out**: package registries and their docs (npm, yarn, PyPI,
  crates, Go), funding pages, schema URLs, framework telemetry notices,
  `example.com`, and the like
- **credentials are taken out before anything is stored**: query parameters
  named like one (`token`, `key`, `secret`, `sig`, `auth`, `code`, `password`,
  `credential`, `session`, …), parameters whose value looks like one (a JWT,
  `ghp_…`, `sk-…`, a long random string), a user and password before the host,
  and a fragment with parameters in it (an OAuth token)
- a localhost URL on a port one of the worktree's crosstalk services has is
  that service's record already, and is not added twice
- **nothing is fetched or opened.** Links found in output are data; the only
  ones crosstalk ever requests are local ones, for the liveness check

**Bounded.** Dead records go after 7 days, links nobody printed again after 7
days, and there are at most 40 per thread (or worktree) and 400 in all: dead
ones first, then links found in output, then the least recently seen.

## 2. Whether it still answers

The daemon checks (`src/urls/liveness.ts`):

| Kind | How | How often |
|---|---|---|
| local | HEAD, then GET if HEAD fails or is refused (405), 2 s each, no redirects followed | every 30 s while a session is live in its worktree (`CROSSTALK_URL_CHECK_MS`), every 5 min otherwise |
| preview | the same | every 5 min |
| pr | `gh pr view <url> --json state`, where gh is installed | every 10 min |
| link | never | |

Any HTTP answer counts as alive (a 500 is a server that runs; the status is
kept). A failure is looked at again after five seconds, and two in a row mark
it dead. A PR that is merged or closed is marked dead with its state. Dead ones
stay in lists, marked, for ten minutes (`CROSSTALK_URL_GRACE_MS`), then drop
out; one that answers again comes back.

## 3. Names, not ports

The daemon runs a small reverse proxy (`src/urls/proxy.ts`):

- **on 127.0.0.1 only**, port `CROSSTALK_PROXY_PORT` when set; otherwise 80
  when it can be bound without privileges (macOS allows it; most Linux does
  not; never taken as root), else **1355**. So the URL is
  `http://auth.localhost` on 80, `http://auth.localhost:1355` otherwise.
  `CROSSTALK_NO_PROXY=1` leaves it off.
- **routing by Host:**

  | Name | Goes to |
  |---|---|
  | `<thread>.localhost` | the thread's main service (`web`, `dev`, `app`, `frontend`, `site`, `ui`, `server`, else the first started) |
  | `<service>.<thread>.localhost` | each of its services |
  | `<service>.localhost` | a service whose name no other thread uses |

  The thread is the worktree's: of a session in it, or of the session that
  started the service; without one, the worktree's folder name. Names are DNS
  labels (lower case, digits, hyphens).
- **follows the port**: the service's current port, looked up again every
  three seconds and at once for a name it does not know, so a service
  restarted on another port keeps its name.
- **websockets and streaming**: once routed, the connection is piped both
  ways as it is, so a dev server's HMR socket, server-sent events and streamed
  responses work. The Host header reaches the server unchanged; Vite, Next.js
  and webpack's dev server accept `*.localhost` by default. It tries
  127.0.0.1, then ::1.
- **an unknown name** gets a small page listing every name there is (`http://localhost:1355/` too).
- **only `*.localhost`**: any other Host (a page that reached the port by DNS
  rebinding sends its own) gets a bare 421 and no list.

Its port and current routes are in `<crosstalk home>/proxy.json` while it
runs; `crosstalk urls routes` prints them, and `crosstalk urls proxy` runs it
in the foreground without a daemon.

**Resolving `*.localhost`.** Browsers (Chrome, Firefox, Safari, Edge) send
every `*.localhost` name to the loopback address themselves, without DNS. Some
command-line tools and libraries do not, depending on the system resolver
(systemd-resolved does; macOS and plain glibc may not). For those:

```sh
curl --resolve auth.localhost:1355:127.0.0.1 http://auth.localhost:1355/
curl -H 'Host: auth.localhost' http://127.0.0.1:1355/
```

or a line in `/etc/hosts`: `127.0.0.1 auth.localhost web.auth.localhost`.

## 4. One list, anywhere

| Where | What |
|---|---|
| `crosstalk_urls {thread?, kind?, alive?}` | the list, this session's first: "what's the auth URL?" Framed as data, inside `<crosstalk-urls>`: labels can come from teammates and links from command output, so they are never instructions. |
| `crosstalk_open_url {name?, thread?, kind?}` | "open the billing preview": the one whose label, name or URL has every word, opened in the browser (`open` on macOS, `xdg-open` elsewhere; never through a shell). A local server opens by its proxy name. Several matches open none and are listed. |
| the pane | a **Links** section: Local, Previews, Pull requests, Links found in output; each clickable (an OSC 8 link in the terminal, only plain http(s)), dead ones marked. The main session's pane lists every thread's. |
| the tab and status line | the worktree's name instead of its port while the proxy is up: `auth · auth.localhost:1355` (no port on 80), else `auth · :4100` as before |
| `crosstalk urls [--thread T] [--kind K] [--json]` | the same list, for scripts |

## 5. Screenshots as evidence

After a change, a headless browser captures the thread's URLs, before and
after; those are what a person reviews. Code: `src/urls/shots/`. Tests:
`test/shots.test.ts`, `test/shots.sh`.

**When.**

| Trigger | What |
|---|---|
| a turn that edited files ends | PostToolUse notes the edit (Edit, Write, MultiEdit, NotebookEdit; one small write); at Stop the turn's thread is captured, in a detached `crosstalk shots turn`, so the hook does not wait. At most once a minute per session (`CROSSTALK_SHOTS_TURN_GAP_MS`); a turn held back keeps its edits for the next Stop. It waits 1.5 s first for a dev server's reload |
| `crosstalk_screenshot {url?, thread?, path?}` | now: the thread's URLs, or one address; `path` (`/login`) on each |
| a local server first answers | the daemon takes one capture of it, a baseline, so the first change has a before |

**What.** The thread's local servers on this machine (crosstalk services, and
localhost URLs a command printed) and shipping's previews, while they answer;
at most six at a time, services first. Never a pull request page, a link found
in output (crosstalk never fetches those), anything dead, or **anything someone
else shared**: those only when the person asks for that address by name.

**With what** (`src/urls/shots/browser.ts`), the first that works:

1. Playwright as a library, when `require("playwright")` resolves (from the
   worktree, then from crosstalk and `NODE_PATH`): its Chromium, else the
   installed Chrome.
2. The worktree's `node_modules/.bin/playwright` (what `npx playwright` runs,
   without installing anything): `playwright screenshot`.
3. An installed Chrome, Chromium, Edge or Brave, driven over the DevTools
   protocol on a pipe (`--headless=new --remote-debugging-pipe`, no port
   opened, a throwaway profile). Not `--screenshot`: Chrome 153 hangs on it.

None: no capture, and the answer says how to get one (`npm i -D playwright`,
`npx playwright install chromium`). Nothing is installed by crosstalk.
1280×800, the page's `load` plus 400 ms (not network idle, which an HMR socket
never reaches). `crosstalk shots engine` says which it would use.

**Before and after.** Captures are kept per URL and path. The after is the
newest; the before is the newest one taken before the change it shows began
(the turn's first edit), so a capture taken mid-turn is never its own before.

**Kept** under `<crosstalk home>/shots/<thread>/`, with
`<crosstalk home>/shots/index.json` (URL, label, path, file, when, size,
thread, worktree, session, why it was taken, the change's start, the engine,
the commit). Bounded: the last 6 of each URL and path
(`CROSSTALK_SHOTS_KEEP`), and 200 MB in all (`CROSSTALK_SHOTS_MAX_MB`), the
oldest going first and each URL's after last.

**As evidence.** Each URL's latest before and after are added to the
`screenshots` of every `crosstalk_evidence` for a feature in that thread
([shipping.md](shipping.md)); they count as a risky feature's proof. Only the
paths go: no image leaves this machine and none goes over the relay. In a
public thread nothing is added.

**Seen.**

| Where | What |
|---|---|
| the pane | a **Screenshots** section: `auth · web · before 2m · after now`, and the two files as OSC 8 `file://` links. A mod cannot draw an image, so a click opens it |
| `crosstalk_screenshots {name?, thread?, open?}` | the pairs, as files; with `open`, "show me the auth page before and after" opens the before and the after in the image viewer (`open` on macOS, `xdg-open` elsewhere, `CROSSTALK_OPEN_FILE_CMD`; never a shell). The page itself is picked over paths on it |
| `crosstalk shots [list\|capture\|open\|engine]` | the same, for scripts and people |

**Off:** `screenshots: off` in the repo's `.crosstalk/ship`, or
`CROSSTALK_NO_SHOTS=1`.

## 6. Servers that look after themselves

The daemon looks at each crosstalk service every two seconds
(`CROSSTALK_HEALTH_TICK_MS`): its process, and its URL's liveness from section
2. Code: `src/urls/health/` (the state machine is pure, `machine.ts`). State in
`<crosstalk home>/health.json`.

| What happened | What crosstalk does |
|---|---|
| it exited with a status other than 0, within 10 s of being seen healthy (a sudden crash) | tells the thread's agent, then restarts it **once** by itself after a backoff (1 s, doubling for each restart in the hour, at most a minute): `crosstalk_serve` again with the same name, command, folder and PORT |
| it crashes again before it has been healthy for two minutes, or crashed without having come up | not restarted. The tab of each session it belongs to turns **broken** (red), and the agent is told, with its log |
| it runs, but its URL failed two checks in a row (after it had answered, or a minute after it started) | broken and told; nothing restarts a process that runs |
| the agent starts it again (`crosstalk_serve`, same name) and it breaks again | the person is told, once (the thread's notice, else the main session's digest). Nothing more is said or restarted until it is healthy or started again |
| it exits with status 0 | nothing: it finished |
| it is healthy again | the tab goes back to what it was |
| `crosstalk_stop` | forgotten |

**Never a loop.** A restart needs a healthy period before the crash, at most
one is spent until it has stayed healthy for two minutes
(`CROSSTALK_HEALTH_STABLE_MS`), and at most three an hour; a restart that shows
no new start within 15 s counts as a failure.

**The heads-up** goes to the sessions of the service's thread in its worktree
(else the one that started it, else any session there) through the own-thread
delivery, the coordinator's heads-up, handed to the agent by itself: "the
auth · web server exited with status 1. It is not restarted by itself. Fix
what made it fail, then start it again with crosstalk_serve, name "web"…",
and the last 40 lines of its log inside `<crosstalk-log>`, as data. A session
with no thread gets it as a held message. With no session to tell, the person
is told instead.

**The broken state** (`src/terminal/status.ts`): red; over done and waiting
while it lasts (working still shows, so an agent fixing it is seen). OSC 9;4
error, iTerm2's and kitty's tab colour, Terminal.app's tint, tmux's
`@crosstalk_state` = `broken`, OSC 7501 `blocked:kind=error`. The pane's
Services line says `web · broken: exited with status 1`.

A restart runs with the daemon's environment (secrets left out as for any
service), not the session's: the session's own environment is not kept on
disk.

## For the builds that come next

Sharing with teammates, the phone and history use the same records (as
screenshots and self-healing do). `src/urls/index.ts` is the front door:

```ts
import { urls, syncServices, recordPreview, recordPr, collectFromOutput, shownUrl, badge } from "./urls/index.ts"
const store = urls()                    // threads wired in
store.add({ url, kind, source, label, thread?, sessionId?, worktree?, service?, feature?, name? })
store.update(id, patch); store.get(id); store.remove(id)
store.list({ thread?, kind?, alive?, sessionId?, worktree?, all? })
store.forThread("auth"); store.forSession({ sessionId, worktree?, thread? })
store.markOk(id, { status? }); store.markFailed(id); store.markDead(id, { state? }); store.prune()
```

The `Url` type is in `src/urls/store.ts`; `urlStore({ file })` opens one
without threads (tests, another home).

Screenshots: `src/urls/shots/index.ts` (`captureFor`, `pairsOf`,
`forEvidence`, `paneShots`, `openPair`; the `Shot` type in `store.ts`). A share
record should carry `sharedBy` (or a `source` of its own): the capture plan
leaves out anything that does unless the person names its address. Health:
`readHealth()` and `brokenIn(root)` in `src/urls/health/index.ts`.

## Not yet checked in real use

- **On a Mac:** binding port 80 without root, the `open` command, Safari's and
  Chrome's handling of `*.localhost` with a port, and clicking the pane's OSC 8
  links in Terminal.app and iTerm2.
- **Real dev servers through the proxy:** Vite's HMR, Next.js, webpack's dev
  server and their Host checks were not run; a bun server and a raw websocket
  stood in.
- **Real Claude Code PostToolUse payloads** for Bash: the hook reads
  `tool_response.stdout` and `stderr`; a background Bash call's output is not
  in the payload and is not read.
- **gh pr view** against real PRs, and preview hosts (Vercel, Fly) for the
  liveness checks.
- **Screenshots on a Mac:** Chrome, Edge and Brave from `/Applications`
  through the DevTools pipe; Playwright installed in a project and found
  there; `npx playwright` (only `node_modules/.bin/playwright` is looked for);
  `open` with two PNGs in Preview; clicking a `file://` OSC 8 link in
  Terminal.app, iTerm2 and Ghostty. Here: Linux, Playwright 1.x with its
  Chromium, and Chrome for Testing 153 through the pipe.
- **Screenshots of real dev servers** (Vite, Next.js) right after an edit:
  whether 1.5 s is enough for a reload, and pages behind a login.
- **The broken tab** in each terminal: only the state file, OSC 9;4 and the
  tmux option were checked; Terminal.app's tint, iTerm2's and kitty's red, and
  the mod's red Services line were not seen.
- **Real Claude Code Stop and PostToolUse payloads** for Edit and Write
  (`tool_name`), and a restart of a real dev server whose environment came from
  a session (the daemon's is used).
