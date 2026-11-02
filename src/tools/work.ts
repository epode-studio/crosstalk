// crosstalk_work: the user's workers and what they run. Start, show, close,
// resume, find, rename, background and steer sessions, here or on the user's
// other machines; restore and gather them; long-running services; cleanup.

import { bool, def, num, oneOf, only, ONLY_USER, str, strs, type Tool } from "./kit.ts"

const ACTIONS = [
  "spawn", "show", "popout", "close", "resume", "find", "rename", "background", "sessions", "steer", "main",
  "restore", "gather", "serve", "services", "stop", "cleanup", "disk", "open", "tidy",
] as const

const description = `The user's sessions and what they run. Actions: spawn (new agents on a task, each in its own worktree and terminal tab, in this session's thread; "put two more on auth"); show / popout (a background agent in a tab); close; resume (a past session; find searches them); rename; background; sessions (what is running, here and on the user's other machines); steer (tell another of the user's sessions something, in the user's words); main (make this the main session, on false to stop); restore (after a restart: "restore them"); gather ("bring my other sessions into crosstalk": ones started before it); serve (a long-running command as a service that outlives this session: use it, not a backgrounded Bash call, for dev servers and watchers; start the server on $PORT; services lists them and, with name and tail, reads a log; stop ends one); tidy ("tidy up": idle sessions and empty tabs closed, similar ones folded into one); cleanup (merged worktrees); disk (Claude Code's leftovers); open (a thread's or session's worktree in the editor).
spawn, close, tidy, resume, rename, background, steer, restore and gather: ${ONLY_USER}. restore, gather, cleanup and disk only list without confirm: true; pass it only when the user agreed in their own words. close, tidy, background or rename of another session, and steer, are confirmed by the user on crosstalk's picker first (steer is refused without crosstalk's mod). Relay result text as it is.`

export const work: Tool = {
  actions: ACTIONS,
  def: def("crosstalk_work", description, ACTIONS, {
    task: str("spawn: the new agent's complete first prompt"),
    count: num("spawn: how many, default 1, at most 8"),
    name: str("spawn, show, popout, serve, services, stop: a short name; rename: the new name"),
    background: bool("spawn: run it in the background, out of sight"),
    thread: str("spawn, open"),
    machine: str("Another of the user's own machines (from sessions), to do it there"),
    repo: str("spawn, with machine: the repository there"),
    session: str("A session's name, id, or a thread only it is in; rename defaults to this one"),
    sessions: strs("tidy: close exactly these (names or ids), when the user named them"),
    merge: bool("tidy: also merge Terminal's windows into tabs"),
    fold: bool("tidy: false leaves similar sessions alone"),
    tabs: bool("tidy: false leaves empty tabs alone"),
    services: oneOf(["keep", "stop"], "close: its services; default keep"),
    query: str("find: words from what it was about"),
    text: str("steer: what to tell it, in the user's words"),
    on: bool("main: false makes this a working session again"),
    confirm: bool("restore, gather, cleanup, disk: true acts, otherwise only lists"),
    include: strs("cleanup: worktrees crosstalk did not make, named by the user"),
    rule: bool("disk: true frees automatically past the budget, false stops that"),
    command: str("serve: the shell command, e.g. npm run dev"),
    cwd: str("serve: the folder, relative to this session's"),
    port: num("serve: the PORT; default this worktree's first free one"),
    tail: num("services, with name: how many log lines"),
    editor: str("open: code, cursor, zed, idea or a command"),
  }),
  route: (a) => {
    switch (a.action) {
      case "spawn":
        return { name: "crosstalk_spawn", args: only(a, "task", "count", "name", "background", "thread", "machine", "repo") }
      case "show":
        return { name: "crosstalk_show", args: only(a, "name") }
      case "popout":
        return { name: "crosstalk_popout", args: only(a, "name") }
      case "close":
        return { name: "crosstalk_close", args: only(a, "session", "services", "machine") }
      case "resume":
        return { name: "crosstalk_resume", args: only(a, "session", "machine") }
      case "find":
        return { name: "crosstalk_find", args: only(a, "query", "machine") }
      case "rename":
        return { name: "crosstalk_rename", args: only(a, "session", "name") }
      case "background":
        return { name: "crosstalk_background", args: only(a, "session", "machine") }
      case "sessions":
        return { name: "crosstalk_sessions", args: only(a, "machine") }
      case "steer":
        return { name: "crosstalk_steer", args: only(a, "session", "text") }
      case "main":
        return { name: "crosstalk_main", args: only(a, "on") }
      case "restore":
        return { name: "crosstalk_restore", args: only(a, "confirm") }
      case "gather":
        return { name: "crosstalk_gather", args: only(a, "confirm") }
      case "serve":
        return { name: "crosstalk_serve", args: only(a, "command", "name", "cwd", "port") }
      case "services":
        return { name: "crosstalk_services", args: only(a, "name", "tail") }
      case "stop":
        return { name: "crosstalk_stop", args: only(a, "name") }
      case "tidy":
        return { name: "crosstalk_tidy", args: only(a, "sessions", "merge", "fold", "tabs") }
      case "cleanup":
        return { name: "crosstalk_cleanup", args: only(a, "confirm", "include") }
      case "disk":
        return { name: "crosstalk_disk", args: only(a, "confirm", "rule") }
      case "open":
        return { name: "crosstalk_open", args: only(a, "thread", "session", "editor") }
    }
    return { error: `crosstalk_work has no action "${a.action}"` }
  },
}
