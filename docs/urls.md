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

## For the builds that come next

Sharing with teammates, screenshots, servers that heal themselves, the phone
and history use the same records. `src/urls/index.ts` is the front door:

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
