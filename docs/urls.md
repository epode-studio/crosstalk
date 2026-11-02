# URLs: what people review

Nobody reads code, so the running thing is what a person looks at
([the design](design/next-generation.md), "URLs are what people review").
crosstalk keeps every URL a thread has, labels it, checks that it still
answers, and gives local servers names instead of ports.

Code: `src/urls/`, `src/urls/history/`, `src/env/`. Tests: `test/urls.test.ts`, `test/urls.sh`, `test/phone.test.ts`, `test/phone.sh`.

## 1. Every URL is collected and labelled

One record per thing to look at, in `<crosstalk home>/urls.json`:

| Kind | Where it comes from | Label |
|---|---|---|
| `local` | a crosstalk service's port (`crosstalk_serve`, [services.md](services.md)), kept current as the port moves | `auth · dev server`, `auth · web` |
| `local` | a localhost URL a Bash command printed (`localhost`, `127.0.0.1`, `::1`, `0.0.0.0`, `*.localhost`) | `auth · :5173` |
| `preview` | shipping's preview of a feature (`src/shipping/engine.ts`), one per thread and feature | `auth · preview` |
| `pr` | the PR shipping opened, or a GitHub PR URL a command printed | `auth · PR #12` |
| `link` | any other link a Bash command printed | `auth · acme.dev/cb` |
| `shared` | a server you share with teammates, or one a teammate shares with you ([8](#8-sharing-a-running-server)) | `auth · web · shared with marie · until 18:00`, `auth · web · from paul · until 18:00` |

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
  three seconds and (at most once a second) for a name it does not know, so
  a service restarted on another port keeps its name. A server shared with
  this machine is routed the moment the offer is taken, and unrouted the
  moment it ends: the daemon tells the proxy rather than waiting for its next
  look.
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

## 5. History

urls.json forgets (dead records after a week); a thread keeps what it had to
look at for its whole life, in a `links` section of the thread itself
(`src/urls/history/links.ts`), so it reaches the thread's people and its ref
like the rest:

- **What is kept**, one entry per thing: its URL, kind, label, first and last
  seen, and the screenshots of it (path, when, the machine that took it, a
  note). A local server is kept **by name and path** (`http://auth.localhost/login`,
  else `http://localhost:5173/login`): never what follows `?` or `#`, so a
  token in a dev server's query string is not kept, and a service on another
  port is the same entry. Other links are kept as urls.json has them
  (credentials already taken out, section 1), without their fragment.
- **Fed by the daemon** (`src/urls/history/sync.ts`) every 30 s
  (`CROSSTALK_HISTORY_MS`): every urls.json record with a thread, from any
  session. Last seen moves at most once an hour, so a server seen every few
  seconds is not an edit every few seconds. Screenshots arrive through
  `noteShot({ urlId | url, path, thread?, note? })`, one line appended to
  `<crosstalk home>/history-shots.jsonl` from any process; the daemon drains it.
- **Merged like every list in a thread**: per entry, last writer wins, so two
  people's sessions recording at once both keep theirs.
- **Sealed like every section**: a sealed thread's file has a `links:` line
  sealed with the thread's key, the section's name inside the seal. A thread
  file from before this section opens with it empty. A public thread's links
  are in its plain-text state like the rest of it.
- **Capped**: 100 entries in full (`MAX_LINKS`). The least recently seen past
  that are folded: a small tombstone with no URL, label or screenshot is left
  (so a replica that still has the entry does not bring it back), and past 300
  tombstones the oldest become a running count. Lists say "N older links were
  folded away".
- **Asking**: `crosstalk_history {thread?, query?, before?, after?}`: "what did
  the login page look like before the redesign?" lists the matching entries,
  most recently seen first, with dates and screenshot paths, inside
  `<crosstalk-history>` (data, not instructions). A screenshot path is a file
  on the machine named with it and exists only there; the list says which is
  this machine.

## 6. On the phone

`crosstalk_qr {name | url, thread?}`: "show me a QR for the auth page" draws a
QR code in the pane (`src/urls/history/phone.ts`, encoder in `qr.ts`: byte
mode, error correction M, else L, versions 1 to 10, no dependencies), as
Unicode half blocks drawn white on black, so it scans on a light or a dark
terminal.

- **What it encodes**: a preview, a PR or another public link, itself. A local
  server (`localhost`, `127.*`, `[::1]`, `0.0.0.0`, `*.localhost`) cannot open
  on a phone, so: its share link when the sharing build gave it one, else the
  thread's deployed preview when it has one that answers (and the pane says
  so), else nothing, and the result says plainly that the phone needs a share
  link. The share link is a public one (`crosstalk_share` with `public: true`,
  [8](#8-sharing-a-running-server)), set on the record as `shareUrl` while it is
  open; a share with people opens only through a crosstalk peer's proxy, and a
  phone is not a peer, so it gives the phone nothing. **Gap:** sharing with your
  own phone without a public link is not built.
- **For the pane only**: the code goes to `<crosstalk home>/qr/<session>.json`
  (30 minutes) and `crosstalk ui pane` adds it to the pane; the mod opens the
  pane on the call, like `crosstalk_pane`. The tool result says it is on
  screen and nothing of what it encodes (a share link is a key to the running
  server). A share link's caption names its host, never its path.
- **Without the mod** the result says there is no pane, and the person runs
  `crosstalk urls qr [name | url]` in a terminal of their own (refused inside
  an agent, `CLAUDECODE` set, for the same reason).

## 7. Servers that just start

A new worktree gets the main checkout's gitignored env and secret files, so
its dev server starts (`src/env/`):

- **When**: crosstalk makes a worktree (`crosstalk_spawn`, `src/spawn.ts`), and
  a session first starts in a worktree of a repo (SessionStart: Claude Code's
  `.claude/worktrees/`, or any other).
- **Which**: `.env` and `.env.*` anywhere, `.dev.vars` anywhere, `config/*.local.*`
  from the top, and the patterns in the repository's own `.crosstalk/env`
  (gitignore-like; `!pattern` leaves out; anything with `..` is refused).
  Never `*.example`, `*.sample`, `*.template`, `*.dist`. Only files
  `git check-ignore` says are ignored and git does not track, in the main
  checkout and in the worktree (a copy never shows in its `git status`);
  regular files under 1 MB, at most 50.
- **How**: copied, never linked (an agent may write its `.env`); mode kept;
  never over a file already there; never through a symlink: a symlinked
  source is refused, the walk never enters a symlinked folder or another
  repository, a destination folder that is a symlink refuses the file, and the
  file is created exclusively. Dependency folders and build output are not
  walked.
- **Asked once per repo**, the first time there is something to copy: "Copy
  .env and 2 other local files into new worktrees of api?" as the mod's picker
  (Copy them / Not in this repo), else a systemMessage (or the spawn's result)
  answered with `crosstalk_env {confirm}`. The answer is kept in
  `<crosstalk home>/env/consent.json`; a yes copies into the asking worktree
  and every worktree crosstalk made of the repo, and into each new one from
  then on. `crosstalk_env` without confirm says what would be copied.
  `CROSSTALK_NO_ENV_COPY=1` turns it off.
- **They never leave the machine**: results, messages and the daemon's log name
  files, never contents; nothing about them goes into a thread or the relay.

## 8. Sharing a running server

"Show marie the auth page" gives marie, and only marie, the running server,
through crosstalk's end-to-end encrypted peer channel. Code: `src/share/`.
Tests: `test/share.test.ts`, `test/share.sh`.

```
marie's browser ─▶ auth.paul.localhost:1355 (marie's proxy)
                    ─▶ a listener on 127.0.0.1 in marie's daemon
                        ─▶ sealed frames over the relay ─▶ paul's daemon
                            ─▶ 127.0.0.1:<the auth service's port>
```

| Tool | What |
|---|---|
| `crosstalk_share {url \| name \| thread, with: [people], for?, public?}` | share one local server (a crosstalk service, or a localhost URL a command printed) with exactly these people, for 8 hours unless `for` says (`2h`, `30m`, `until 18:00`; a week at most) |
| `crosstalk_unshare {id \| url \| name \| thread, with?}` | stop it now, for everyone or only `with`: open requests and websockets are cut off |
| `crosstalk_shares` | what you share and what is shared with you, framed as data |

**On the owner's machine (paul).** The share is one URL record and the people
named in it, each by the fingerprint of their direct channel: exact crosstalk
names (`marie`, never a prefix), never an agent, never someone muted; a person
trusted through a repository is included on each of their machines. A
`shared` record, `auth · web · shared with marie · until 18:00`, is in the
pane's **Shared** links and in `crosstalk_urls`. Each frame from marie's daemon
is checked against the share as it arrives: her fingerprint in it, not muted
now, not an agent, the share neither expired nor stopped. A request goes to
127.0.0.1 (then ::1) on the share's port and nowhere else: a frame names a
share and a stream, never a host or a port, its path must be origin-form
(`/…`; an absolute URL or CONNECT is refused), and crosstalk's own proxy port
is never forwarded to. A crosstalk service's port is looked up afresh for each
request, so a service that restarts on another port stays shared.

**On the viewer's machine (marie).** The offer comes over the direct channel
(never through a room, never from an agent or someone muted) and becomes:

- a listener on 127.0.0.1, answering only loopback Host names
  (`*.localhost`, `localhost`, `127.0.0.1`), so a page that reached it by DNS
  rebinding gets a 421;
- a name through marie's proxy, `<name>.<owner>.localhost`: `auth.paul.localhost`
  for the thread's main server, `web-auth.paul.localhost` for another; never a
  bare name, never shadowing one of marie's own;
- a `shared` record, `auth · web · from paul · until 18:00`, in her pane and her
  agent's `crosstalk_urls`, inside `<crosstalk-urls>` as data, so her agent can
  test against it;
- a card, **Open it / Not now / Stop it**, or a digest line without the mod.
  Nothing is opened by itself. Stop it closes it on her side and tells paul.

**HTTP over frames.** One stream per request or websocket. A request is `req`
(method, path, headers), its body in `body` frames, `end`; the answer is `res`
(status, headers), `body` frames, `end`, or `error`. Bodies go in 48 KB chunks,
so a large response streams as it is written and no frame nears the relay's
1 MB limit; websockets are `wsopen`, `wsmsg` (text or binary), `wsclose`, with
the subprotocol the server chose. Hop-by-hop headers (Connection and what it
names, Keep-Alive, Transfer-Encoding, Upgrade, TE, Trailer, Proxy-*) are taken
out both ways. Cookie and Authorization pass: **marie's browser talks to paul's
server as itself**, so paul's server sees marie's requests and cookies, marked
`x-crosstalk-viewer: marie`, and the Host as marie's browser sent it
(`auth.paul.localhost:1355`, which Vite, Next.js and webpack accept).

**Limits.** 64 streams open per person and share, request bodies up to 32 MB,
responses up to 256 MB, websocket messages up to 16 MB. Both daemons pace what
they send (80 frames and 3 MB a second, with bursts), below what the relay
takes, and paul's holds what each person sends to twice that; more gets 429.
Frames are live: the self-hosted relay carries them as `stream` frames, with a
budget of their own and never buffered for someone offline; a self-hosted relay
that predates them carries them as ordinary sends, much slower (60 a minute).
The hosted relay carries them as `stream` frames too, never stored, with a
daily allowance because it is a free plan everyone shares: 4,000 frames a day
per person and 15,000 for everyone together (`worker/README.md` has the
arithmetic: sharing as a whole stays under a sixth of the relay's day). Past
it, the relay says `stream_paused`, sharing stops until 00:00 UTC, and both
people get a plain message: "sharing through the shared relay is paused until
tomorrow; run your own relay with `--host` or `worker/`". Messages keep
working. On the hosted relay share frames never fall back to ordinary sends,
which are stored: one that has not been redeployed with stream frames carries
no sharing at all, and the person is told so once (`src/streamgate.ts`).

**Ending.** At its expiry each side ends it by itself; `crosstalk_unshare`
ends it at once and tells everyone in it. Either way open requests get 410,
websockets close with 1008, marie's listener and name go, and both records are
marked ended. A share is in `<crosstalk home>/shares.json`; after a restart
marie's listeners come back on new ports with the same names.

**A public link** only when the person asks for one in so many words
(`public: true`): the existing quick-tunnel path (`src/tunnel.ts`,
cloudflared, never downloaded) pointed at the service, with a loud warning,
an hour by default and eight at most, and it dies with the daemon. Anyone with
the link reaches the server. While it is open the server's record carries it
as `shareUrl`, which is what a QR code for the phone encodes
([6](#6-on-the-phone)). A share with people has no such link: it opens only
through a crosstalk peer's own proxy, and a phone is not a crosstalk peer.

## 9. Screenshots as evidence

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
public thread nothing is added. Each capture also goes into the thread's
history (section 5), by its path.

**Seen.**

| Where | What |
|---|---|
| the pane | a **Screenshots** section: `auth · web · before 2m · after now`, and the two files as OSC 8 `file://` links. A mod cannot draw an image, so a click opens it |
| `crosstalk_screenshots {name?, thread?, open?}` | the pairs, as files; with `open`, "show me the auth page before and after" opens the before and the after in the image viewer (`open` on macOS, `xdg-open` elsewhere, `CROSSTALK_OPEN_FILE_CMD`; never a shell). The page itself is picked over paths on it |
| `crosstalk shots [list\|capture\|open\|engine]` | the same, for scripts and people |

**Off:** `screenshots: off` in the repo's `.crosstalk/ship`, or
`CROSSTALK_NO_SHOTS=1`.

## 10. Servers that look after themselves

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

Sharing, screenshots, servers that heal themselves, the phone and history
all use the same records. `src/urls/index.ts` is the front door:

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
Every capture is passed to `noteShot({ urlId, path, note? })` from
`src/urls/history/sync.ts`, which puts it in the thread's history. For
**sharing**: a local record whose share link is in `shareUrl` (or
`share.url`), or another public record naming it in `sharedFrom`, is what
`crosstalk_qr` encodes for it (`shareLinkFor` in `src/urls/history/phone.ts`).

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
- **QR codes with a real phone camera**: the encoder is checked by a decoder in
  the tests and the standard's vectors, not by scanning; nor how the mod's
  pane draws `backgroundColor` in Terminal.app and iTerm2, or whether a narrow
  pane cuts the code (it is 25 to 61 columns wide).
- **Env copying on a Mac**: APFS modes and `O_NOFOLLOW`, git's
  `check-ignore` with a case-insensitive file system, and `.env` files in
  monorepos deeper than eight folders (not walked).
- **Sharing between two real machines:** three identities on one machine and
  a local relay stood in, and the Worker's stream frames under a local
  `wrangler dev` (`test/share-worker.sh`). Not run: the deployed hosted relay
  (not redeployed with stream frames yet), a public link through a
  real cloudflared, Vite or Next.js HMR through a share, Safari and Chrome on
  `*.<owner>.localhost` names, and the share card in the mod.
