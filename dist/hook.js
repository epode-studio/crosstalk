#!/usr/bin/env bun
// @bun

// src/hook.ts
import path14 from "path";
import os6 from "os";
import fs11 from "fs";

// src/client.ts
import net from "node:net";
import fs from "node:fs";
import { spawn } from "node:child_process";

// src/config.ts
import os from "node:os";
import path from "node:path";
var ROOT = process.env.CROSSTALK_HOME ?? path.join(os.homedir(), ".claude", "crosstalk");
var P = {
  root: ROOT,
  identity: path.join(ROOT, "identity.json"),
  peers: path.join(ROOT, "peers.json"),
  relay: path.join(ROOT, "relay.json"),
  queue: path.join(ROOT, "queue.json"),
  parked: path.join(ROOT, "parked.json"),
  sessions: path.join(ROOT, "sessions.json"),
  outbox: path.join(ROOT, "outbox.json"),
  usage: path.join(ROOT, "usage.json"),
  routes: path.join(ROOT, "routes.json"),
  unrouted: path.join(ROOT, "unrouted.json"),
  daemonSock: path.join(ROOT, "daemon.sock"),
  daemonLock: path.join(ROOT, "daemon.lock"),
  log: path.join(ROOT, "daemon.log")
};

// src/paths.ts
import path2 from "node:path";
import { fileURLToPath } from "node:url";
var dirOf = (metaUrl) => path2.dirname(fileURLToPath(metaUrl));
var rootFrom = (metaUrl) => path2.join(dirOf(metaUrl), "..");
var shim = (root) => path2.join(root, "bin", "crosstalk");

// src/client.ts
function request(req, timeoutMs = 130000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(P.daemonSock);
    let rest = "";
    const t = setTimeout(() => {
      sock.destroy();
      reject(new Error("daemon did not answer"));
    }, timeoutMs);
    sock.on("connect", () => sock.write(JSON.stringify(req) + `
`));
    sock.on("data", (b) => {
      rest += b.toString("utf8");
      const i = rest.indexOf(`
`);
      if (i === -1)
        return;
      clearTimeout(t);
      const line = rest.slice(0, i);
      sock.end();
      try {
        resolve(JSON.parse(line));
      } catch (e) {
        reject(e);
      }
    });
    sock.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}
function daemonRunning() {
  try {
    const pid = Number(fs.readFileSync(P.daemonLock, "utf8"));
    process.kill(pid, 0);
    return fs.existsSync(P.daemonSock);
  } catch {
    return false;
  }
}
async function ensureDaemon(root = rootFrom(import.meta.url)) {
  if (daemonRunning())
    return true;
  const out = fs.openSync(P.log, "a");
  const child = spawn(shim(root), ["daemon"], {
    detached: true,
    stdio: ["ignore", out, out]
  });
  child.unref();
  for (let i = 0;i < 40; i++) {
    if (daemonRunning())
      return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// src/config.ts
import fs2 from "node:fs";
import os2 from "node:os";
import path3 from "node:path";
import { execFileSync } from "node:child_process";
var ROOT2 = process.env.CROSSTALK_HOME ?? path3.join(os2.homedir(), ".claude", "crosstalk");
var P2 = {
  root: ROOT2,
  identity: path3.join(ROOT2, "identity.json"),
  peers: path3.join(ROOT2, "peers.json"),
  relay: path3.join(ROOT2, "relay.json"),
  queue: path3.join(ROOT2, "queue.json"),
  parked: path3.join(ROOT2, "parked.json"),
  sessions: path3.join(ROOT2, "sessions.json"),
  outbox: path3.join(ROOT2, "outbox.json"),
  usage: path3.join(ROOT2, "usage.json"),
  routes: path3.join(ROOT2, "routes.json"),
  unrouted: path3.join(ROOT2, "unrouted.json"),
  daemonSock: path3.join(ROOT2, "daemon.sock"),
  daemonLock: path3.join(ROOT2, "daemon.lock"),
  log: path3.join(ROOT2, "daemon.log")
};
function readJson(file, fallback) {
  try {
    return JSON.parse(fs2.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
var KEYCHAIN_SERVICE = "crosstalk-identity";
var keychain = {
  available: () => process.platform === "darwin",
  read() {
    try {
      const out = execFileSync("security", ["find-generic-password", "-a", "crosstalk", "-s", KEYCHAIN_SERVICE, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      return out ? JSON.parse(Buffer.from(out, "base64").toString("utf8")) : null;
    } catch {
      return null;
    }
  },
  write(id) {
    execFileSync("security", [
      "add-generic-password",
      "-a",
      "crosstalk",
      "-s",
      KEYCHAIN_SERVICE,
      "-w",
      Buffer.from(JSON.stringify(id), "utf8").toString("base64"),
      "-U"
    ], { stdio: ["ignore", "ignore", "ignore"] });
  },
  clear() {
    try {
      execFileSync("security", ["delete-generic-password", "-a", "crosstalk", "-s", KEYCHAIN_SERVICE], {
        stdio: "ignore"
      });
    } catch {}
  }
};
var loadIdentity = () => {
  const onDisk = readJson(P2.identity, null);
  if (onDisk?.storage === "keychain") {
    const full = keychain.read();
    if (full)
      return full;
    return null;
  }
  return onDisk;
};

// src/paths.ts
import path4 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var dirOf2 = (metaUrl) => path4.dirname(fileURLToPath2(metaUrl));
var rootFrom2 = (metaUrl) => path4.join(dirOf2(metaUrl), "..");

// src/footprint.ts
function pathsFromToolInput(input) {
  if (!input || typeof input !== "object")
    return [];
  const i = input;
  const out = [];
  for (const k of ["file_path", "notebook_path", "path"]) {
    const v = i[k];
    if (typeof v === "string" && v)
      out.push(v);
  }
  for (const k of ["command", "patch", "input"]) {
    const v = i[k];
    const text = typeof v === "string" ? v : Array.isArray(v) ? v.join(`
`) : "";
    for (const m of text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm))
      out.push(m[1].trim());
  }
  return [...new Set(out)].slice(0, 20);
}

// src/restore.ts
import fs3 from "node:fs";
import os3 from "node:os";
import path6 from "node:path";
import { spawn as spawn2, spawnSync as spawnSync2 } from "node:child_process";

// src/terminal/repo.ts
import { spawnSync } from "node:child_process";
import path5 from "node:path";
var git = (cwd, args) => {
  try {
    const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 1e4, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    return { ok: r.status === 0, out: (r.stdout ?? "").trim() || (r.status === 0 ? "" : (r.stderr ?? "").trim()) };
  } catch (e) {
    return { ok: false, out: String(e) };
  }
};
function parseWorktrees(porcelain) {
  const out = [];
  let cur = null;
  for (const line of porcelain.split(`
`)) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice(9) };
      out.push(cur);
    } else if (!cur)
      continue;
    else if (line.startsWith("HEAD "))
      cur.head = line.slice(5);
    else if (line.startsWith("branch "))
      cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (line === "bare")
      cur.bare = true;
    else if (line === "detached")
      cur.detached = true;
  }
  return out;
}
function worktrees(cwd, g = git) {
  const r = g(cwd, ["worktree", "list", "--porcelain"]);
  return r.ok ? parseWorktrees(r.out) : [];
}
var cache = new Map;
function repoOf(cwd, g = git) {
  if (!cwd)
    return null;
  if (cache.has(cwd))
    return cache.get(cwd);
  let key = null;
  const main = worktrees(cwd, g)[0];
  if (main && !main.bare)
    key = main.path;
  else {
    const top = g(cwd, ["rev-parse", "--show-toplevel"]);
    if (top.ok && top.out)
      key = top.out;
  }
  cache.set(cwd, key);
  return key;
}
var repoKey = (cwd, g = git) => repoOf(cwd, g) ?? path5.resolve(cwd);

// src/restore.ts
var dir = () => path6.join(P.root, "open");
var safe = (id) => id.replace(/[^A-Za-z0-9._-]/g, "_");
var fileOf = (id) => path6.join(dir(), `${safe(id)}.json`);
function readAll() {
  let names;
  try {
    names = fs3.readdirSync(dir()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const f of names) {
    try {
      const r = JSON.parse(fs3.readFileSync(path6.join(dir(), f), "utf8"));
      if (r && typeof r.sessionId === "string")
        out.push(r);
    } catch {}
  }
  return out;
}
function readOne(id) {
  try {
    return JSON.parse(fs3.readFileSync(fileOf(id), "utf8"));
  } catch {
    return null;
  }
}
function writeRec(r) {
  fs3.mkdirSync(dir(), { recursive: true, mode: 448 });
  const tmp = `${fileOf(r.sessionId)}.${process.pid}.tmp`;
  fs3.writeFileSync(tmp, JSON.stringify(r, null, 2), { mode: 384 });
  fs3.renameSync(tmp, fileOf(r.sessionId));
}
function removeRec(id) {
  try {
    fs3.unlinkSync(fileOf(id));
  } catch {}
}
function prune(now = Date.now()) {
  for (const r of readAll())
    if (r.endedAt && now - r.endedAt > DAY || !r.endedAt && now - r.seenAt > 7 * DAY && !recAlive(r))
      removeRec(r.sessionId);
}
var stateFile = () => path6.join(P.root, "restore-state.json");
function loadState() {
  try {
    return JSON.parse(fs3.readFileSync(stateFile(), "utf8"));
  } catch {
    return {};
  }
}
function saveState(s) {
  fs3.mkdirSync(P.root, { recursive: true, mode: 448 });
  fs3.writeFileSync(stateFile(), JSON.stringify(s, null, 2), { mode: 384 });
}
var DAY = 24 * 60 * 60 * 1000;
var WINDOW_MS = DAY;
var SHUTDOWN_MS = 10 * 60 * 1000;
var BURST_MS = 10 * 1000;
function bootTime(env = process.env, now = Date.now()) {
  const forced = Number(env.CROSSTALK_BOOT_TIME);
  if (forced > 0)
    return forced;
  return now - os3.uptime() * 1000;
}
function endedNormally(r, all, boot) {
  if (!r.endedAt)
    return false;
  if (r.endReason !== "other")
    return true;
  if (r.endedAt < boot && boot - r.endedAt <= SHUTDOWN_MS)
    return false;
  const burst = all.some((o) => o.sessionId !== r.sessionId && o.endReason === "other" && !!o.endedAt && Math.abs(o.endedAt - r.endedAt) <= BURST_MS);
  return !burst;
}
function isLost(r, c) {
  if (r.interactive === false)
    return false;
  if (endedNormally(r, c.all, c.boot))
    return false;
  const before = r.seenAt < c.boot;
  const ref = before ? c.boot : c.now;
  if (ref - r.seenAt > WINDOW_MS)
    return false;
  if (!before && r.client !== "claude")
    return false;
  return !c.alive(r);
}
function lostSessions(c, self) {
  return order(c.all.filter((r) => r.sessionId !== self && isLost(r, c)));
}
var order = (rs) => [...rs].sort((a, b) => a.startedAt - b.startedAt);
function ps(pid, field) {
  if (!pid || pid < 1)
    return null;
  try {
    const r = spawnSync2("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
    if (r.status !== 0)
      return null;
    return r.stdout.trim() || null;
  } catch {
    return null;
  }
}
function pidAlive(pid, pidStart) {
  if (!pid || pid < 1)
    return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    if (e?.code !== "EPERM")
      return false;
  }
  if (!pidStart)
    return true;
  const now = ps(pid, "lstart");
  return now === null ? true : now === pidStart;
}
var recAlive = (r) => pidAlive(r.pid, r.pidStart);
var SHELL = /^-?(sh|bash|zsh|dash|fish|ksh|tcsh|csh)$/;
function sessionPid(sessionId) {
  try {
    const reg = path6.join(os3.homedir(), ".claude", "sessions");
    for (const f of fs3.readdirSync(reg)) {
      if (!f.endsWith(".json"))
        continue;
      try {
        const e = JSON.parse(fs3.readFileSync(path6.join(reg, f), "utf8"));
        if (e.sessionId === sessionId && Number(e.pid) > 0)
          return Number(e.pid);
      } catch {}
    }
  } catch {}
  let pid = process.ppid;
  for (let i = 0;i < 4; i++) {
    const comm = ps(pid, "comm");
    if (!comm || !SHELL.test(path6.basename(comm)))
      break;
    const up = Number(ps(pid, "ppid"));
    if (!up || up <= 1)
      break;
    pid = up;
  }
  return pid;
}
var appleLocateScript = (tty) => [
  `tell application "Terminal"`,
  `	repeat with w in windows`,
  `		set n to 0`,
  `		repeat with t in tabs of w`,
  `			set n to n + 1`,
  `			if (tty of t) is ${asq(tty)} then return ((id of w) as text) & " " & (n as text)`,
  `		end repeat`,
  `	end repeat`,
  `end tell`,
  `return ""`
].join(`
`);
function captureTerminal(env, pid, probe) {
  const t = {};
  if (env.TERM_PROGRAM)
    t.program = env.TERM_PROGRAM;
  const tty = ps(pid, "tty");
  if (tty && !/^\?+$/.test(tty))
    t.tty = tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
  if (env.TMUX && env.TMUX_PANE) {
    t.tmux = { pane: env.TMUX_PANE, socket: env.TMUX.split(",")[0] };
    if (probe) {
      const r = spawnSync2("tmux", ["display", "-p", "-t", env.TMUX_PANE, "#{session_name}\t#{window_index}\t#{pane_index}"], { encoding: "utf8", timeout: 2000, env });
      const [s, w, p] = (r.stdout ?? "").trim().split("\t");
      if (r.status === 0 && s)
        Object.assign(t.tmux, { session: s, window: Number(w), paneIndex: Number(p) });
    }
  }
  if (env.KITTY_WINDOW_ID || env.KITTY_LISTEN_ON)
    t.kitty = { window: env.KITTY_WINDOW_ID, listenOn: env.KITTY_LISTEN_ON };
  if (env.WEZTERM_PANE)
    t.wezterm = { pane: env.WEZTERM_PANE };
  if (env.ITERM_SESSION_ID) {
    const m = /^w(\d+)t(\d+)p(\d+)/.exec(env.ITERM_SESSION_ID);
    t.iterm = { id: env.ITERM_SESSION_ID, ...m ? { window: Number(m[1]), tab: Number(m[2]) } : {} };
  }
  if (env.WT_SESSION)
    t.wt = { session: env.WT_SESSION };
  if (env.TERM_PROGRAM === "Apple_Terminal" || env.TERM_SESSION_ID && !t.iterm) {
    t.apple = { sessionId: env.TERM_SESSION_ID };
    if (probe && t.tty && process.platform === "darwin" && env.TERM_PROGRAM === "Apple_Terminal") {
      const r = spawnSync2("osascript", ["-"], { input: appleLocateScript(t.tty), encoding: "utf8", timeout: 2500 });
      const [w, n] = (r.stdout ?? "").trim().split(" ").map(Number);
      if (r.status === 0 && w && n)
        Object.assign(t.apple, { window: w, tab: n });
    }
    if (env.TERM_PROGRAM !== "Apple_Terminal" && !t.apple.window)
      delete t.apple;
  }
  return t;
}
var shq = (s) => /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
var asq = (s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
function resumeArgv(r, bin) {
  if (r.client === "claude")
    return [bin ?? "claude", "--resume", r.sessionId];
  if (r.client === "codex")
    return [bin ?? "codex", "resume", r.sessionId];
  return null;
}
var typed = (r) => `cd ${shq(r.cwd)} && ${resumeArgv(r).map(shq).join(" ")}`;
function kindOf(t) {
  if (!t)
    return null;
  if (t.tmux)
    return "tmux";
  if (t.program === "Apple_Terminal")
    return "apple";
  if (t.program === "iTerm.app" || t.iterm)
    return "iterm";
  if (t.program === "ghostty")
    return "ghostty";
  if (t.kitty)
    return "kitty";
  if (t.wezterm || t.program === "WezTerm")
    return "wezterm";
  if (t.wt)
    return "wt";
  if (t.apple)
    return "apple";
  return null;
}
function appName(t) {
  switch (t?.program) {
    case "Apple_Terminal":
      return "Terminal";
    case "iTerm.app":
      return "iTerm";
    case "ghostty":
      return "Ghostty";
    case "WezTerm":
      return "WezTerm";
    case "vscode":
      return "Visual Studio Code";
    default:
      return "the app crosstalk runs in";
  }
}
var CROSSTALK_TMUX = "crosstalk";
var isCrosstalkSocket = (s) => !!s && path6.basename(s) === CROSSTALK_TMUX;
function anchorFor(repo, o) {
  if (o.asking && kindOf(o.asking.terminal) && o.keyOf(o.asking.cwd) === repo)
    return o.asking.terminal;
  const live = o.recs.filter((r) => !r.endedAt && r.interactive !== false && kindOf(r.terminal) && !isCrosstalkSocket(r.terminal.tmux?.socket) && o.keyOf(r.cwd) === repo && o.alive(r)).sort((a, b) => b.seenAt - a.seenAt);
  return live[0]?.terminal ?? null;
}
function appleIntoWindowScript(cmds, window, tabs) {
  const L = [
    `set crosstalkFallback to ""`,
    `tell application "Terminal"`,
    `	if not (exists window id ${window}) then`,
    `		set crosstalkFallback to "gone"`,
    `	else`,
    `		set index of window id ${window} to 1`,
    `		activate`,
    `	end if`,
    `end tell`
  ];
  for (const c of cmds)
    L.push(`if crosstalkFallback is "" and ${tabs ? "true" : "false"} then`, `	try`, `		delay 0.3`, `		tell application "System Events" to keystroke "t" using command down`, `		delay 0.6`, `		tell application "Terminal" to do script ${asq(c)} in selected tab of front window`, `	on error errMsg number errNum`, `		set crosstalkFallback to (errNum as text)`, `		tell application "Terminal" to do script ${asq(c)}`, `	end try`, `else`, `	tell application "Terminal" to do script ${asq(c)}`, `end if`);
  L.push(`if crosstalkFallback is "gone" then set crosstalkFallback to ""`, `return "done " & crosstalkFallback`);
  return L.join(`
`);
}
function itermIntoWindowScript(cmds, tty) {
  const L = [`tell application "iTerm2"`, `	set w to missing value`];
  if (tty)
    L.push(`	repeat with aw in windows`, `		repeat with t in tabs of aw`, `			repeat with s in sessions of t`, `				if (tty of s) is ${asq(tty)} then set w to aw`, `			end repeat`, `		end repeat`, `	end repeat`);
  L.push(`	if w is missing value then`, `		set w to (create window with default profile)`, `		tell current session of w to write text ${asq(cmds[0])}`, `	else`, `		tell w`, `			set t to (create tab with default profile)`, `			tell current session of t to write text ${asq(cmds[0])}`, `		end tell`, `	end if`);
  for (const c of cmds.slice(1))
    L.push(`	tell w`, `		set t to (create tab with default profile)`, `		tell current session of t to write text ${asq(c)}`, `	end tell`);
  L.push(`end tell`, `return "done "`);
  return L.join(`
`);
}
function usable(k, e, t) {
  switch (k) {
    case "tmux":
      return e.has("tmux");
    case "apple":
    case "iterm":
    case "ghostty":
      return e.platform === "darwin" && e.has("osascript");
    case "kitty":
      return e.has("kitten") && !!(e.current.kitty?.listenOn ?? t?.kitty?.listenOn);
    case "wezterm":
      return e.has("wezterm");
    case "wt":
      return e.platform === "win32" && e.has("wt");
  }
}
function adapterFor(r, e) {
  if (/[\n\r\0]/.test(r.cwd) || !r.cwd)
    return "manual";
  const own = kindOf(r.terminal);
  if (own && usable(own, e, r.terminal))
    return own;
  const cur = kindOf(e.current);
  if (cur && usable(cur, e, e.current))
    return cur;
  return "manual";
}
var groupBy = (xs, key) => {
  const m = new Map;
  for (const x of xs)
    m.set(key(x), [...m.get(key(x)) ?? [], x]);
  return m;
};
var num = (n) => n === undefined || Number.isNaN(n) ? Infinity : n;
function appleTerminalScript(cmds, tabs) {
  const L = [`set crosstalkFallback to ""`, `tell application "Terminal"`, `	activate`, `	do script ${asq(cmds[0])}`, `end tell`];
  for (const c of cmds.slice(1)) {
    if (!tabs) {
      L.push(`tell application "Terminal" to do script ${asq(c)}`);
      continue;
    }
    L.push(`if crosstalkFallback is "" then`, `	try`, `		delay 0.3`, `		tell application "System Events" to keystroke "t" using command down`, `		delay 0.6`, `		tell application "Terminal" to do script ${asq(c)} in selected tab of front window`, `	on error errMsg number errNum`, `		set crosstalkFallback to (errNum as text)`, `		tell application "Terminal" to do script ${asq(c)}`, `	end try`, `else`, `	tell application "Terminal" to do script ${asq(c)}`, `end if`);
  }
  L.push(`return "done " & crosstalkFallback`);
  return L.join(`
`);
}
function itermScript(cmds) {
  const L = [`tell application "iTerm2"`, `	activate`, `	set w to (create window with default profile)`, `	tell current session of w to write text ${asq(cmds[0])}`];
  for (const c of cmds.slice(1))
    L.push(`	tell w`, `		set t to (create tab with default profile)`, `		tell current session of t to write text ${asq(c)}`, `	end tell`);
  L.push(`end tell`, `return "done "`);
  return L.join(`
`);
}
function ghosttyScript(cmds) {
  const L = [`set crosstalkFallback to ""`, `tell application "Ghostty" to activate`, `delay 0.5`, `try`];
  cmds.forEach((c, i) => {
    L.push(`	tell application "System Events"`, `		keystroke ${i === 0 ? `"n"` : `"t"`} using command down`, `		delay 0.8`, `		keystroke ${asq(c)}`, `		key code 36`, `	end tell`);
  });
  L.push(`on error errMsg number errNum`, `	set crosstalkFallback to (errNum as text)`, `end try`, `return "done " & crosstalkFallback`);
  return L.join(`
`);
}
var wtArg = (s) => s.replace(/;/g, "\\;");
function plan(recs, e) {
  const skipped = recs.filter((r) => !resumeArgv(r));
  const ok = order(recs.filter((r) => resumeArgv(r)));
  const byKind = groupBy(ok, (r) => adapterFor(r, e));
  const plans = [];
  const exec = (r) => resumeArgv(r, e.which(r.client === "codex" ? "codex" : "claude"));
  const repoOf = e.repoOf;
  const repoFirst = new Map;
  if (repoOf) {
    for (const r of ok)
      if (!repoFirst.has(repoOf(r.cwd)))
        repoFirst.set(repoOf(r.cwd), r.startedAt);
  }
  const byRepo = (rs, oldWindow) => {
    const groups = groupBy(rs, (r) => repoOf ? repoOf(r.cwd) : oldWindow(r));
    const keys = [...groups.keys()].sort((a, b) => repoOf ? repoFirst.get(a) - repoFirst.get(b) : num(Number(a)) - num(Number(b)));
    return keys.map((k) => ({ key: k, recs: groups.get(k), anchor: repoOf ? e.anchorFor?.(k) ?? null : null }));
  };
  const inRepoOrder = (rs) => byRepo(rs, () => "").flatMap((x) => x.recs);
  for (const [kind, rs] of byKind) {
    if (kind === "tmux") {
      const groups = groupBy(rs, (r) => `${isCrosstalkSocket(r.terminal.tmux?.socket) ? "L" : ""}	${r.terminal.tmux?.session ?? e.current.tmux?.session ?? "crosstalk"}`);
      for (const [key, g] of groups) {
        const [own, name] = key.split("\t");
        const S = own ? ["-L", CROSSTALK_TMUX] : [];
        const sorted = [...g].sort((a, b) => num(a.terminal.tmux?.window) - num(b.terminal.tmux?.window) || num(a.terminal.tmux?.paneIndex) - num(b.terminal.tmux?.paneIndex) || a.startedAt - b.startedAt);
        let exists = own ? e.tmuxHasSession(name, CROSSTALK_TMUX) : e.tmuxHasSession(name);
        const steps = sorted.map((r) => {
          const cmd = exec(r).map(shq).join(" ");
          if (!exists) {
            exists = true;
            return { cmd: "tmux", args: [...S, "new-session", "-d", "-s", name, "-c", r.cwd, cmd] };
          }
          return { cmd: "tmux", args: [...S, "new-window", "-d", "-t", `=${name}:`, "-c", r.cwd, cmd] };
        });
        plans.push({ kind: "tmux", sessions: sorted, steps });
      }
    } else if (kind === "apple") {
      for (const { recs, anchor } of byRepo(rs, (r) => String(r.terminal.apple?.window ?? "?"))) {
        const g = [...recs].sort((a, b) => (repoOf ? num(a.terminal.apple?.window) - num(b.terminal.apple?.window) : 0) || num(a.terminal.apple?.tab) - num(b.terminal.apple?.tab) || a.startedAt - b.startedAt);
        const into = anchor?.apple?.window;
        const tabs = e.tabs && (g.length > 1 || !!into);
        plans.push({
          kind: "apple",
          sessions: g,
          needsAccessibility: tabs,
          steps: [{ cmd: "osascript", args: ["-"], input: into ? appleIntoWindowScript(g.map(typed), into, e.tabs) : appleTerminalScript(g.map(typed), tabs) }]
        });
      }
    } else if (kind === "iterm") {
      for (const { recs, anchor } of byRepo(rs, (r) => String(r.terminal.iterm?.window ?? "?"))) {
        const g = [...recs].sort((a, b) => (repoOf ? num(a.terminal.iterm?.window) - num(b.terminal.iterm?.window) : 0) || num(a.terminal.iterm?.tab) - num(b.terminal.iterm?.tab) || a.startedAt - b.startedAt);
        const input = anchor?.tty ? itermIntoWindowScript(g.map(typed), anchor.tty) : itermScript(g.map(typed));
        plans.push({ kind: "iterm", sessions: g, steps: [{ cmd: "osascript", args: ["-"], input }] });
      }
    } else if (kind === "ghostty") {
      const g = inRepoOrder(rs);
      if (e.tabs)
        plans.push({ kind: "ghostty", sessions: g, needsAccessibility: true, steps: [{ cmd: "osascript", args: ["-"], input: ghosttyScript(g.map(typed)) }] });
      else
        plans.push({ kind: "manual", sessions: g, steps: [] });
    } else if (kind === "kitty") {
      const to = e.current.kitty?.listenOn ?? rs[0].terminal.kitty?.listenOn;
      for (const { recs, anchor } of byRepo(rs, () => "")) {
        const match = anchor?.kitty?.window ? ["--match", `window_id:${anchor.kitty.window}`] : [];
        plans.push({
          kind: "kitty",
          sessions: recs,
          steps: recs.map((r) => ({ cmd: "kitten", args: ["@", "--to", to, "launch", "--type=tab", ...match, "--cwd", r.cwd, ...exec(r)] }))
        });
      }
    } else if (kind === "wezterm") {
      for (const { recs, anchor } of byRepo(rs, () => "")) {
        const at = anchor?.wezterm?.pane ? ["--pane-id", anchor.wezterm.pane] : [];
        plans.push({
          kind: "wezterm",
          sessions: recs,
          steps: recs.map((r) => ({ cmd: "wezterm", args: ["cli", "spawn", ...at, "--cwd", r.cwd, "--", ...exec(r)] }))
        });
      }
    } else if (kind === "wt") {
      plans.push({
        kind: "wt",
        sessions: rs,
        steps: rs.map((r) => ({ cmd: "wt", args: ["-w", "0", "nt", "-d", wtArg(r.cwd), ...exec(r).map(wtArg)] }))
      });
    } else {
      plans.push({ kind: "manual", sessions: rs, steps: [] });
    }
  }
  return { plans, skipped };
}
var SETTINGS_URL = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"
};
function classifyOsaError(text) {
  if (/-1743\b|not authori[sz]ed to send apple events/i.test(text))
    return "automation";
  if (/-25211\b|-1719\b|^1002$|\(1002\)|assistive access|not allowed to send keystrokes|accessibility/i.test(text.trim()))
    return "accessibility";
  return null;
}
var REOPEN_SETTINGS_MS = 2 * 60 * 1000;
function shouldOpenSettings(o) {
  if (!o.userAction)
    return false;
  const last = o.state.settingsOpened?.[o.pane];
  return !(last && o.now - last < REOPEN_SETTINGS_MS);
}
function permissionSteps(pane, app) {
  return pane === "accessibility" ? [
    `System Settings \u2192 Privacy & Security \u2192 Accessibility \u2192 turn on ${app}`,
    `open "${SETTINGS_URL.accessibility}"`
  ] : [
    `System Settings \u2192 Privacy & Security \u2192 Automation \u2192 ${app} \u2192 turn on System Events`,
    `open "${SETTINGS_URL.automation}"`
  ];
}
var JXA_AX = `ObjC.import("ApplicationServices"); var f; try { f = $.AXIsProcessTrusted() } catch (e) { ObjC.bindFunction("AXIsProcessTrusted", ["bool", []]); f = $.AXIsProcessTrusted() } f ? "yes" : "no"`;
function accessibilityGranted() {
  if (process.platform !== "darwin")
    return null;
  const forced = process.env.CROSSTALK_FAKE_ACCESSIBILITY;
  if (forced)
    return forced === "yes";
  const r = spawnSync2("osascript", ["-l", "JavaScript", "-e", JXA_AX], { encoding: "utf8", timeout: 3000 });
  const out = (r.stdout ?? "").trim();
  return out === "yes" ? true : out === "no" ? false : null;
}
function openSettings(pane) {
  if (process.env.CROSSTALK_NO_OPEN)
    return;
  spawnSync2("open", [SETTINGS_URL[pane]], { timeout: 5000 });
}
function which(bin) {
  for (const d of (process.env.PATH ?? "").split(path6.delimiter)) {
    if (!d)
      continue;
    const p = path6.join(d, bin);
    try {
      fs3.accessSync(p, fs3.constants.X_OK);
      return p;
    } catch {}
  }
  return;
}
function liveEnv(env, tabs) {
  return {
    platform: process.platform,
    current: captureTerminal(env, process.pid, true),
    has: (b) => !!which(b),
    which,
    tmuxHasSession: (name, socket) => spawnSync2("tmux", [...socket ? ["-L", socket] : [], "has-session", "-t", `=${name}`], { stdio: "ignore", timeout: 2000, env: socket ? { ...env, TMUX: "" } : env }).status === 0,
    tabs,
    repoOf: (cwd) => repoKey(cwd),
    anchorFor: (repo) => anchorFor(repo, { recs: readAll(), keyOf: (cwd) => repoKey(cwd), alive: recAlive })
  };
}
var label = (r) => r.name && !/^session-\d+$/.test(r.name) ? r.name : path6.basename(r.cwd) || r.sessionId.slice(0, 8);
var names = (rs, max = 4) => rs.slice(0, max).map(label).join(", ") + (rs.length > max ? ", \u2026" : "");
var commandsFile = () => path6.join(P.root, "restore-commands.sh");
function ctxNow() {
  const now = Date.now();
  return { now, boot: bootTime(process.env, now), all: readAll(), alive: recAlive };
}
function question(lost, boot, current) {
  if (!lost.length)
    return null;
  const n = lost.length;
  const restart = lost.some((r) => r.seenAt < boot);
  const what = `${n} session${n === 1 ? " was" : "s were"} open ${restart ? "before the restart" : "when they were cut off"}`;
  const k = kindOf(current);
  const firstTime = (k === "apple" || k === "ghostty") && process.platform === "darwin" && !loadState().tabsWorked && n > 1 ? ` The first time, macOS asks whether ${appName(current)} may control System Events: allow it, so they open as tabs.` : "";
  return `\u25e2 crosstalk: ${what} (${names(lost)}). Say "restore them" to bring ${n === 1 ? "it" : "them"} back.${firstTime}`;
}
function askOnceOffer(self, current) {
  const c = ctxNow();
  const lost = lostSessions(c, self);
  if (!lost.some((r) => !r.askedAt))
    return null;
  const lock = path6.join(dir(), ".asking");
  try {
    fs3.mkdirSync(dir(), { recursive: true, mode: 448 });
    try {
      if (Date.now() - fs3.statSync(lock).mtimeMs > 30000)
        fs3.rmdirSync(lock);
    } catch {}
    fs3.mkdirSync(lock);
  } catch {
    return null;
  }
  try {
    const fresh = lostSessions(ctxNow(), self);
    if (!fresh.some((r) => !r.askedAt))
      return null;
    for (const r of fresh)
      if (!r.askedAt)
        writeRec({ ...r, askedAt: Date.now() });
    const text = question(fresh, c.boot, current);
    if (!text)
      return null;
    return {
      text,
      count: fresh.length,
      names: fresh.slice(0, 4).map(label).concat(fresh.length > 4 ? ["\u2026"] : []),
      restart: fresh.some((r) => r.seenAt < c.boot)
    };
  } finally {
    try {
      fs3.rmdirSync(lock);
    } catch {}
  }
}
function forget(self) {
  const lost = lostSessions(ctxNow(), self);
  for (const r of lost)
    removeRec(r.sessionId);
  return {
    ok: true,
    text: lost.length ? `\u25e2 crosstalk: left ${lost.length} session${lost.length === 1 ? "" : "s"} closed.` : "\u25e2 crosstalk: nothing to restore.",
    lost,
    restored: []
  };
}
var pendingFile = () => path6.join(P.root, "restore-pending.json");
function claimPending() {
  const mine = `${pendingFile()}.${process.pid}`;
  try {
    fs3.renameSync(pendingFile(), mine);
  } catch {
    return null;
  }
  try {
    return JSON.parse(fs3.readFileSync(mine, "utf8"));
  } catch {
    return null;
  } finally {
    try {
      fs3.unlinkSync(mine);
    } catch {}
  }
}
function runStep(s) {
  const r = spawnSync2(s.cmd, s.args, { input: s.input, encoding: "utf8", timeout: 60000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}`.trim() };
}
function restore(o, only) {
  const env = o.env ?? process.env;
  const lost = only ?? lostSessions(ctxNow(), o.self);
  if (!lost.length)
    return { ok: true, text: "\u25e2 crosstalk: nothing to restore.", lost, restored: [] };
  claimPending();
  const e = liveEnv(env, o.tabs ?? true);
  let { plans, skipped } = plan(lost, e);
  const app = appName(e.current);
  const notes = [];
  const state = loadState();
  if (plans.some((p) => p.needsAccessibility) && accessibilityGranted() === false) {
    const opened = shouldOpenSettings({ pane: "accessibility", userAction: o.userAction, state, now: Date.now() });
    if (opened) {
      openSettings("accessibility");
      saveState({ ...state, settingsOpened: { ...state.settingsOpened, accessibility: Date.now() } });
    }
    const p = { ids: lost.map((r) => r.sessionId), current: e.current, until: Date.now() + WAIT_MS(), self: o.self };
    fs3.mkdirSync(P.root, { recursive: true, mode: 448 });
    fs3.writeFileSync(pendingFile(), JSON.stringify(p), { mode: 384 });
    startWaiter(o.root);
    const [steps, cmd] = permissionSteps("accessibility", app);
    return {
      ok: true,
      text: [
        `\u25e2 crosstalk needs permission to open tabs in ${app}.`,
        opened ? `  Opened System Settings. Turn on ${app} under Accessibility; crosstalk will finish restoring by itself.` : `  ${steps}`,
        ...opened ? [] : [`  ${cmd}`, `  crosstalk will finish restoring by itself once it is on.`]
      ].join(`
`),
      lost,
      restored: []
    };
  }
  for (const r of lost)
    removeRec(r.sessionId);
  const restored = [];
  const failed = [];
  const manual = [];
  let missing = null;
  for (const p of plans) {
    if (p.kind === "manual") {
      manual.push(...p.sessions);
      continue;
    }
    let ok = true;
    let out = "";
    for (const s of p.steps) {
      const r = runStep(s);
      out += r.out + `
`;
      if (!r.ok) {
        ok = false;
        break;
      }
    }
    const fellBack = /done (-?\d+)/.exec(out);
    if (ok && fellBack) {
      missing = classifyOsaError(fellBack[1]) ?? "automation";
      notes.push(`Opened ${p.sessions.length} in ${app} as separate windows: ${app} ${missing === "accessibility" ? "may not type keys (Accessibility)" : "may not control System Events (Automation)"}.`);
    } else if (ok && p.needsAccessibility)
      saveState({ ...loadState(), tabsWorked: Date.now() });
    if (ok)
      restored.push(...p.sessions);
    else {
      missing ??= classifyOsaError(out);
      failed.push(...p.sessions);
      notes.push(`${p.kind} could not open ${names(p.sessions)}: ${out.trim().split(`
`).pop()}`);
    }
  }
  const rest = [...manual, ...failed];
  for (const r of failed)
    writeRec(r);
  if (rest.length) {
    const lines = rest.map(typed);
    fs3.mkdirSync(P.root, { recursive: true, mode: 448 });
    fs3.writeFileSync(commandsFile(), `#!/bin/sh
# Sessions crosstalk could not reopen by itself. Each line is one tab.
${lines.join(`
`)}
`, { mode: 448 });
    notes.push(`Paste each line into its own tab (also in ${commandsFile()}):`, ...lines.map((l) => `  ${l}`));
  }
  if (skipped.length)
    notes.push(`Skipped ${names(skipped)}: ${[...new Set(skipped.map((r) => r.client))].join(", ")} cannot resume a session.`);
  for (const r of skipped)
    removeRec(r.sessionId);
  if (missing && process.platform === "darwin") {
    const opened = shouldOpenSettings({ pane: missing, userAction: o.userAction, state: loadState(), now: Date.now() });
    if (opened) {
      openSettings(missing);
      const s = loadState();
      saveState({ ...s, settingsOpened: { ...s.settingsOpened, [missing]: Date.now() } });
    }
    const [steps, cmd] = permissionSteps(missing, app);
    notes.push(opened ? `Opened System Settings, so next time they open as tabs: ${steps}` : `For tabs next time: ${steps}`, `  ${cmd}`);
  }
  const head = restored.length ? `\u25e2 crosstalk: reopened ${restored.length} session${restored.length === 1 ? "" : "s"} (${names(restored)}).` : `\u25e2 crosstalk: reopened nothing.`;
  return { ok: !failed.length, text: [head, ...notes.map((n) => `  ${n}`)].join(`
`), lost, restored };
}
var WAIT_MS = () => Number(process.env.CROSSTALK_RESTORE_WAIT_MS ?? 2 * 60 * 1000);
function startWaiter(root) {
  if (process.env.CROSSTALK_NO_WAITER)
    return;
  try {
    const child = spawn2(shim(root ?? rootFrom(import.meta.url)), ["restore", "--finish"], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
  } catch {}
}
function parseShortcut(prompt) {
  const m = /^@restore(?:\s+(\S+))?$/i.exec(prompt.trim());
  if (!m)
    return null;
  const w = (m[1] ?? "").toLowerCase();
  if (!w || w === "yes" || w === "y")
    return "yes";
  if (w === "no" || w === "n")
    return "no";
  if (w === "windows")
    return "windows";
  return null;
}
function note(o) {
  const now = Date.now();
  const read = readOne(o.sessionId);
  const before = read?.adopted ? null : read;
  if (/^SessionEnd$/i.test(o.event)) {
    if (before)
      writeRec({ ...before, endedAt: now, endReason: o.reason ?? "other", seenAt: now });
    return;
  }
  const start = /^SessionStart$/i.test(o.event);
  const turnEnd = /^Stop$/i.test(o.event);
  if (!start && before && !turnEnd) {
    if (now - before.seenAt > 60000)
      writeRec({ ...before, seenAt: now, cwd: o.cwd || before.cwd });
    return;
  }
  const pid = start || !before ? sessionPid(o.sessionId) : before.pid;
  const args = start || !before ? ps(pid, "args") ?? "" : "";
  const rec = {
    sessionId: o.sessionId,
    cwd: o.cwd,
    client: o.client,
    name: o.name ?? before?.name,
    pid,
    pidStart: start || !before ? ps(pid, "lstart") ?? undefined : before.pidStart,
    interactive: start || !before ? !/(^|\s)(-p|--print)(\s|$)/.test(args) : before.interactive,
    startedAt: read?.startedAt ?? now,
    seenAt: now,
    terminal: captureTerminal(o.env, pid, true)
  };
  writeRec(rec);
  if (start)
    prune(now);
}

// src/uistate.ts
import fs4 from "node:fs";
import path7 from "node:path";
var FINAL = new Set(["answered", "handed", "muted"]);
var file = () => path7.join(P.root, "ui.json");
var lockDir = () => path7.join(P.root, "ui.lock");
var markers = () => path7.join(P.root, "ui-mod");
var safe2 = (id) => id.replace(/[^A-Za-z0-9._-]/g, "_");
var WEEK = 7 * 24 * 60 * 60 * 1000;
function read() {
  try {
    const f = JSON.parse(fs4.readFileSync(file(), "utf8"));
    if (f && f.v === 1 && f.items && typeof f.items === "object")
      return f;
  } catch {}
  return { v: 1, items: {} };
}
function write(f) {
  fs4.mkdirSync(P.root, { recursive: true, mode: 448 });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs4.writeFileSync(tmp, JSON.stringify(f, null, 2), { mode: 384 });
  fs4.renameSync(tmp, file());
}
var sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function withStore(fn) {
  fs4.mkdirSync(P.root, { recursive: true, mode: 448 });
  let held = false;
  for (let i = 0;i < 200 && !held; i++) {
    try {
      fs4.mkdirSync(lockDir());
      held = true;
    } catch {
      try {
        if (Date.now() - fs4.statSync(lockDir()).mtimeMs > 1e4)
          fs4.rmdirSync(lockDir());
      } catch {}
      sleepSync(10);
    }
  }
  try {
    const f = read();
    const was = JSON.stringify(f);
    const now = Date.now();
    const out = fn(f.items, now);
    for (const [id, it] of Object.entries(f.items))
      if (FINAL.has(it.state) && now - it.updatedAt > WEEK || now - it.updatedAt > 4 * WEEK)
        delete f.items[id];
    if (JSON.stringify(f) !== was)
      write(f);
    return out;
  } finally {
    if (held)
      try {
        fs4.rmdirSync(lockDir());
      } catch {}
  }
}
function upsert(items, it, now) {
  const before = items[it.id];
  if (!before)
    return items[it.id] = { ...it, state: "pending", createdAt: now, updatedAt: now };
  if (FINAL.has(before.state))
    return before;
  const moved = before.sessionId !== it.sessionId;
  items[it.id] = {
    ...before,
    ...it,
    state: before.state,
    raisedAt: moved ? undefined : before.raisedAt,
    createdAt: before.createdAt,
    updatedAt: moved ? now : before.updatedAt
  };
  return items[it.id];
}
var MARKER_MS = 10 * 60 * 1000;
function modActive(sessionId, now = Date.now()) {
  try {
    return now - fs4.statSync(path7.join(markers(), safe2(sessionId))).mtimeMs < MARKER_MS;
  } catch {
    return false;
  }
}
var restoreId = (sessionId) => `restore:${sessionId}`;
function restoreSurface(sessionId, offer) {
  if (!offer)
    return {};
  if (!modActive(sessionId))
    return { systemMessage: offer.text };
  const n = offer.count;
  const when = offer.restart === false ? n === 1 ? "that was cut off" : "that were cut off" : "from before the restart";
  try {
    return { item: storeRestore(sessionId, offer, n, when) };
  } catch {
    return { systemMessage: offer.text };
  }
}
var gatherId = (sessionId) => `gather:${sessionId}`;
var GATHER_OPTIONS = ["Bring them in", "Not now"];
function gatherSurface(sessionId, offer, mod = modActive(sessionId)) {
  if (!offer)
    return {};
  if (!mod)
    return { systemMessage: offer.text };
  try {
    return {
      item: withStore((items, now) => upsert(items, {
        id: gatherId(sessionId),
        kind: "gather",
        sessionId,
        count: offer.count,
        names: offer.names,
        question: offer.question,
        options: GATHER_OPTIONS
      }, now))
    };
  } catch {
    return { systemMessage: offer.text };
  }
}
function storeRestore(sessionId, offer, n, when) {
  return withStore((items, now) => upsert(items, {
    id: restoreId(sessionId),
    kind: "restore",
    sessionId,
    count: n,
    names: offer.names,
    question: `Restore ${n} session${n === 1 ? "" : "s"} ${when}? (${offer.names.join(", ")})`,
    options: ["Restore", "Open as windows", "Not now"]
  }, now));
}

// src/gather.ts
import fs6 from "node:fs";
import os5 from "node:os";
import path9 from "node:path";
import { spawn as spawn4, spawnSync as spawnSync4 } from "node:child_process";

// src/restore.ts
import fs5 from "node:fs";
import os4 from "node:os";
import path8 from "node:path";
import { spawn as spawn3, spawnSync as spawnSync3 } from "node:child_process";
var dir2 = () => path8.join(P.root, "open");
var safe3 = (id) => id.replace(/[^A-Za-z0-9._-]/g, "_");
var fileOf2 = (id) => path8.join(dir2(), `${safe3(id)}.json`);
function readAll2() {
  let names;
  try {
    names = fs5.readdirSync(dir2()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const f of names) {
    try {
      const r = JSON.parse(fs5.readFileSync(path8.join(dir2(), f), "utf8"));
      if (r && typeof r.sessionId === "string")
        out.push(r);
    } catch {}
  }
  return out;
}
function readOne2(id) {
  try {
    return JSON.parse(fs5.readFileSync(fileOf2(id), "utf8"));
  } catch {
    return null;
  }
}
function writeRec2(r) {
  fs5.mkdirSync(dir2(), { recursive: true, mode: 448 });
  const tmp = `${fileOf2(r.sessionId)}.${process.pid}.tmp`;
  fs5.writeFileSync(tmp, JSON.stringify(r, null, 2), { mode: 384 });
  fs5.renameSync(tmp, fileOf2(r.sessionId));
}
var DAY2 = 24 * 60 * 60 * 1000;
var SHUTDOWN_MS2 = 10 * 60 * 1000;
var BURST_MS2 = 10 * 1000;
function bootTime2(env = process.env, now = Date.now()) {
  const forced = Number(env.CROSSTALK_BOOT_TIME);
  if (forced > 0)
    return forced;
  return now - os4.uptime() * 1000;
}
function ps2(pid, field) {
  if (!pid || pid < 1)
    return null;
  try {
    const r = spawnSync3("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
    if (r.status !== 0)
      return null;
    return r.stdout.trim() || null;
  } catch {
    return null;
  }
}
function pidAlive2(pid, pidStart) {
  if (!pid || pid < 1)
    return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    if (e?.code !== "EPERM")
      return false;
  }
  if (!pidStart)
    return true;
  const now = ps2(pid, "lstart");
  return now === null ? true : now === pidStart;
}
var recAlive2 = (r) => pidAlive2(r.pid, r.pidStart);
var appleLocateScript2 = (tty) => [
  `tell application "Terminal"`,
  `	repeat with w in windows`,
  `		set n to 0`,
  `		repeat with t in tabs of w`,
  `			set n to n + 1`,
  `			if (tty of t) is ${asq2(tty)} then return ((id of w) as text) & " " & (n as text)`,
  `		end repeat`,
  `	end repeat`,
  `end tell`,
  `return ""`
].join(`
`);
var asq2 = (s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
function kindOf2(t) {
  if (!t)
    return null;
  if (t.tmux)
    return "tmux";
  if (t.program === "Apple_Terminal")
    return "apple";
  if (t.program === "iTerm.app" || t.iterm)
    return "iterm";
  if (t.program === "ghostty")
    return "ghostty";
  if (t.kitty)
    return "kitty";
  if (t.wezterm || t.program === "WezTerm")
    return "wezterm";
  if (t.wt)
    return "wt";
  if (t.apple)
    return "apple";
  return null;
}
var REOPEN_SETTINGS_MS2 = 2 * 60 * 1000;

// src/gather.ts
var registryDir = () => path9.join(os5.homedir(), ".claude", "sessions");
function readRegistry(dir = registryDir(), alive = (p) => pidAlive2(p)) {
  let files;
  try {
    files = fs6.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const e = JSON.parse(fs6.readFileSync(path9.join(dir, f), "utf8"));
      const pid = Number(e.pid ?? f.slice(0, -5));
      if (!pid || typeof e.sessionId !== "string" || !e.sessionId)
        continue;
      if (!alive(pid))
        continue;
      out.push({
        pid,
        sessionId: e.sessionId,
        cwd: e.cwd ?? "",
        status: e.status ?? "unknown",
        name: e.name,
        startedAt: typeof e.startedAt === "number" ? e.startedAt : undefined,
        kind: e.kind
      });
    } catch {}
  }
  return out;
}
function registryPids(dir = registryDir()) {
  try {
    return new Set(fs6.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).map((f) => Number(f.slice(0, -5))));
  } catch {
    return new Set;
  }
}
function ps3(pid, field) {
  if (!pid || pid < 1)
    return null;
  try {
    const r = spawnSync4("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
    if (r.status !== 0)
      return null;
    return r.stdout.trim() || null;
  } catch {
    return null;
  }
}
var ENV_KEYS = ["TERM_PROGRAM", "TERM_SESSION_ID", "TMUX", "TMUX_PANE", "KITTY_WINDOW_ID", "KITTY_LISTEN_ON", "WEZTERM_PANE", "ITERM_SESSION_ID", "WT_SESSION"];
function parseEnv(text, sep) {
  const out = {};
  for (const part of text.split(sep)) {
    const i = part.indexOf("=");
    if (i < 1)
      continue;
    const k = part.slice(0, i);
    if (ENV_KEYS.includes(k))
      out[k] = part.slice(i + 1);
  }
  return out;
}
function procEnv(pid) {
  try {
    return parseEnv(fs6.readFileSync(`/proc/${pid}/environ`, "utf8"), /\0/);
  } catch {}
  if (process.platform !== "darwin")
    return null;
  try {
    const r = spawnSync4("ps", ["-wwE", "-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
    if (r.status !== 0)
      return null;
    return parseEnv(r.stdout.trim(), /\s+/);
  } catch {
    return null;
  }
}
function tmuxPanes() {
  const r = spawnSync4("tmux", ["list-panes", "-a", "-F", "#{pane_tty}\t#{pane_id}\t#{session_name}\t#{window_index}\t#{pane_index}\t#{socket_path}"], { encoding: "utf8", timeout: 2000 });
  if (r.status !== 0)
    return [];
  return r.stdout.trim().split(`
`).filter(Boolean).map((l) => {
    const [tty, pane, session, w, p, socket] = l.split("\t");
    return { tty, pane, session, window: Number(w), paneIndex: Number(p), socket };
  });
}
var appleLocateIfRunning = (tty) => [`if application "Terminal" is running then`, ...appleLocateScript2(tty).split(`
`).slice(0, -1).map((l) => `	${l}`), `end if`, `return ""`].join(`
`);
function liveSys() {
  return {
    platform: process.platform,
    now: Date.now,
    ps: ps3,
    alive: pidAlive2,
    env: procEnv,
    tmuxPanes,
    appleLocate: (tty) => {
      if (process.platform !== "darwin")
        return null;
      const r = spawnSync4("osascript", ["-"], { input: appleLocateIfRunning(tty), encoding: "utf8", timeout: 2500 });
      const [w, n] = (r.stdout ?? "").trim().split(" ").map(Number);
      return r.status === 0 && w && n ? { window: w, tab: n } : null;
    },
    kill: (pid, sig) => process.kill(pid, sig),
    run: (s) => {
      const r = spawnSync4(s.cmd, s.args, { input: s.input, encoding: "utf8", timeout: 30000 });
      return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}`.trim() };
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms))
  };
}
function terminalOf(tty, env, sys, panes) {
  const t = {};
  if (env.TERM_PROGRAM)
    t.program = env.TERM_PROGRAM;
  if (tty)
    t.tty = tty;
  const pane = tty ? (panes ?? sys.tmuxPanes)().find((p) => p.tty === tty) : undefined;
  if (pane)
    t.tmux = { pane: pane.pane, socket: pane.socket, session: pane.session, window: pane.window, paneIndex: pane.paneIndex };
  else if (env.TMUX && env.TMUX_PANE)
    t.tmux = { pane: env.TMUX_PANE, socket: env.TMUX.split(",")[0] };
  if (env.KITTY_WINDOW_ID || env.KITTY_LISTEN_ON)
    t.kitty = { window: env.KITTY_WINDOW_ID, listenOn: env.KITTY_LISTEN_ON };
  if (env.WEZTERM_PANE)
    t.wezterm = { pane: env.WEZTERM_PANE };
  if (env.ITERM_SESSION_ID) {
    const m = /^w(\d+)t(\d+)p(\d+)/.exec(env.ITERM_SESSION_ID);
    t.iterm = { id: env.ITERM_SESSION_ID, ...m ? { window: Number(m[1]), tab: Number(m[2]) } : {} };
  }
  if (env.WT_SESSION)
    t.wt = { session: env.WT_SESSION };
  const appleMaybe = env.TERM_PROGRAM === "Apple_Terminal" || !env.TERM_PROGRAM && !t.iterm && !t.kitty && !t.wezterm;
  if (tty && !t.tmux && appleMaybe && sys.platform === "darwin") {
    const at = sys.appleLocate(tty);
    if (at) {
      t.program = "Apple_Terminal";
      t.apple = { sessionId: env.TERM_SESSION_ID, window: at.window, tab: at.tab };
    } else if (env.TERM_PROGRAM === "Apple_Terminal")
      t.apple = { sessionId: env.TERM_SESSION_ID };
  }
  return t;
}
var RECHECK_MS = 10 * 60 * 1000;
function snapshot(o) {
  const { sys } = o;
  const now = sys.now();
  const byId = new Map(o.records.map((r) => [r.sessionId, r]));
  const out = [];
  let panes;
  const lazyPanes = () => panes ??= sys.tmuxPanes();
  const live = new Set;
  for (const e of o.registry) {
    live.add(e.sessionId);
    if (e.sessionId === o.self)
      continue;
    const before = byId.get(e.sessionId);
    if (before && !before.adopted)
      continue;
    if (before?.endedAt && before.pid === e.pid)
      continue;
    const pidStart = sys.ps(e.pid, "lstart") ?? undefined;
    if (!sys.alive(e.pid, pidStart))
      continue;
    const rawTty = sys.ps(e.pid, "tty");
    const tty = rawTty && !/^\?+$/.test(rawTty) ? rawTty.startsWith("/dev/") ? rawTty : `/dev/${rawTty}` : undefined;
    const same = before && before.pid === e.pid && before.pidStart === pidStart && before.terminal.tty === tty;
    const fresh = same && now - (before.watchedAt ?? 0) < RECHECK_MS;
    out.push({
      ...before ?? {},
      sessionId: e.sessionId,
      cwd: e.cwd || before?.cwd || "",
      client: "claude",
      name: e.name ?? before?.name,
      pid: e.pid,
      pidStart,
      interactive: !!tty,
      startedAt: before?.startedAt ?? e.startedAt ?? now,
      seenAt: now,
      watchedAt: fresh ? before.watchedAt : now,
      terminal: fresh ? before.terminal : terminalOf(tty, sys.env(e.pid) ?? {}, sys, lazyPanes),
      adopted: "watched"
    });
  }
  for (const r of o.records) {
    if (r.adopted !== "watched" || r.endedAt || live.has(r.sessionId))
      continue;
    if (r.seenAt < o.boot || o.registryPids.has(r.pid))
      continue;
    if (sys.alive(r.pid, r.pidStart))
      continue;
    out.push({ ...r, endedAt: now, endReason: "exit" });
  }
  return out;
}
function watch(self, sys = liveSys()) {
  const recs = snapshot({
    self,
    registry: readRegistry(registryDir(), (p) => sys.alive(p)),
    records: readAll2(),
    registryPids: registryPids(),
    boot: bootTime2(process.env, sys.now()),
    sys
  });
  for (const r of recs)
    writeRec2(r);
  return recs;
}
var WATCH_EVERY_MS = () => Number(process.env.CROSSTALK_WATCH_EVERY_MS ?? 60000);
var stampFile = () => path9.join(P.root, "watch-stamp");
function watchThrottled(self, now = Date.now()) {
  try {
    if (now - fs6.statSync(stampFile()).mtimeMs < WATCH_EVERY_MS())
      return false;
  } catch {}
  try {
    fs6.mkdirSync(P.root, { recursive: true, mode: 448 });
    fs6.writeFileSync(stampFile(), String(now), { mode: 384 });
    watch(self);
    return true;
  } catch {
    return false;
  }
}
var stateFile2 = () => path9.join(P.root, "gather-state.json");
function loadState2() {
  try {
    return JSON.parse(fs6.readFileSync(stateFile2(), "utf8"));
  } catch {
    return {};
  }
}
function saveState2(s) {
  fs6.mkdirSync(P.root, { recursive: true, mode: 448 });
  const tmp = `${stateFile2()}.${process.pid}.tmp`;
  fs6.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 384 });
  fs6.renameSync(tmp, stateFile2());
}
var sleepSync2 = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function locked(fn) {
  const lock = path9.join(P.root, "gather.lock");
  fs6.mkdirSync(P.root, { recursive: true, mode: 448 });
  let held = false;
  for (let i = 0;i < 100 && !held; i++) {
    try {
      fs6.mkdirSync(lock);
      held = true;
    } catch {
      try {
        if (Date.now() - fs6.statSync(lock).mtimeMs > 1e4)
          fs6.rmdirSync(lock);
      } catch {}
      sleepSync2(10);
    }
  }
  if (!held)
    return null;
  try {
    return fn();
  } finally {
    try {
      fs6.rmdirSync(lock);
    } catch {}
  }
}
function ancestors(pid = process.pid, sys = { ps: ps3 }) {
  const out = [];
  let p = pid;
  for (let i = 0;i < 12 && p > 1; i++) {
    out.push(p);
    const up = Number(sys.ps(p, "ppid"));
    if (!up || up === p)
      break;
    p = up;
  }
  return out;
}
function candidates(recs, o) {
  return recs.filter((r) => r.adopted === "watched" && !r.endedAt && r.interactive !== false && r.sessionId !== o.self && !(o.selfPids ?? []).includes(r.pid) && r.gather?.state !== "done" && o.alive(r)).sort((a, b) => a.startedAt - b.startedAt);
}
var offerQuestion = (n) => `${n} Claude session${n === 1 ? "" : "s"} started before crosstalk. Bring ${n === 1 ? "it" : "them"} in? Idle ones restart in their tab with their conversation.`;
function offerFor(cands, state) {
  const asked = new Set(state.offered?.ids ?? []);
  if (!cands.length || cands.every((r) => asked.has(r.sessionId)))
    return null;
  const n = cands.length;
  const names = cands.slice(0, 4).map(label2).concat(n > 4 ? ["\u2026"] : []);
  return {
    count: n,
    names,
    question: offerQuestion(n),
    text: `\u25e2 crosstalk: ${offerQuestion(n)} (${names.join(", ")}) Say "bring them in" to do it.`
  };
}
var label2 = (r) => r.name && !/^session-\d+$/.test(r.name) ? r.name : path9.basename(r.cwd) || r.sessionId.slice(0, 8);
function offerOnce(self) {
  const cands = candidates(readAll2(), { self, selfPids: ancestors(), alive: recAlive2 });
  if (!offerFor(cands, loadState2()))
    return null;
  return locked(() => {
    const s = loadState2();
    const offer = offerFor(cands, s);
    if (!offer)
      return null;
    saveState2({ ...s, offered: { at: Date.now(), by: self, ids: [...new Set([...s.offered?.ids ?? [], ...cands.map((r) => r.sessionId)])] } });
    return offer;
  });
}
function takeNote(session, id) {
  if (!loadState2().notes?.some((n) => (!session || !n.session || n.session === session) && (!id || n.id === id)))
    return null;
  return locked(() => {
    const s = loadState2();
    const i = (s.notes ?? []).findIndex((n) => (!session || !n.session || n.session === session) && (!id || n.id === id));
    if (i === -1)
      return null;
    const [n] = s.notes.splice(i, 1);
    saveState2(s);
    return { id: n.id, text: n.text };
  });
}

// src/terminal/status.ts
import fs7 from "node:fs";
import path10 from "node:path";
import { spawn as spawn5, spawnSync as spawnSync5 } from "node:child_process";
var COLOUR = {
  working: [47, 111, 214],
  waiting: [229, 140, 10],
  done: [46, 160, 67]
};
var hex = ([r, g, b]) => `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
function stateForEvent(o) {
  switch (o.event) {
    case "UserPromptSubmit":
      return "working";
    case "Stop":
      return o.pending > 0 ? "waiting" : "done";
    case "Notification": {
      const t = o.notificationType ?? "";
      if (/idle/i.test(t))
        return o.pending > 0 && o.current !== "working" ? "waiting" : null;
      if (!t && !/permission|waiting|needs|approve|input/i.test(o.message ?? ""))
        return null;
      return "waiting";
    }
    case "PostToolUse":
    case "PreToolUse":
      return o.current === "waiting" ? "working" : null;
    case "SessionEnd":
      return "off";
    default:
      return null;
  }
}
var ST = "\x1B\\";
function progressSequence(state) {
  if (state === "working")
    return `\x1B]9;4;3${ST}`;
  if (state === "waiting")
    return `\x1B]9;4;4;100${ST}`;
  return `\x1B]9;4;0${ST}`;
}
function drawsProgress(env) {
  if (env.TMUX)
    return true;
  if (env.WT_SESSION)
    return true;
  const p = env.TERM_PROGRAM ?? "";
  if (p === "ghostty" || p === "WezTerm")
    return true;
  if (p === "iTerm.app") {
    const [maj, min] = (env.TERM_PROGRAM_VERSION ?? "0").split(".").map(Number);
    return maj > 3 || maj === 3 && min >= 6;
  }
  return false;
}
var b64 = (s) => Buffer.from(s, "utf8").toString("base64");
function itermTabColour(state) {
  if (state === "off")
    return `\x1B]6;1;bg;*;default\x07`;
  const [r, g, b] = COLOUR[state];
  return `\x1B]6;1;bg;red;brightness;${r}\x07\x1B]6;1;bg;green;brightness;${g}\x07\x1B]6;1;bg;blue;brightness;${b}\x07`;
}
var userVar = (state) => `\x1B]1337;SetUserVar=crosstalk_state=${state === "off" ? "" : b64(state)}\x07`;
var TMUX_OPTION = "@crosstalk_state";
function tmuxActions(t, state) {
  const S = t.socket ? ["-S", t.socket] : [];
  const set = state === "off" ? ["set-option", "-w", "-u", "-t", t.pane, TMUX_OPTION] : ["set-option", "-w", "-t", t.pane, TMUX_OPTION, state];
  return [
    { kind: "run", step: { cmd: "tmux", args: [...S, ...set] } },
    { kind: "run", step: { cmd: "tmux", args: [...S, "refresh-client", "-S"] }, optional: true }
  ];
}
function kittyActions(k, state) {
  if (!k.window || !k.listenOn)
    return [];
  const c = state === "off" ? "NONE" : hex(COLOUR[state]);
  return [
    { kind: "run", step: { cmd: "kitten", args: ["@", "--to", k.listenOn, "set-tab-color", "--match", `window_id:${k.window}`, `active_bg=${c}`, `inactive_bg=${c}`] } },
    { kind: "run", step: { cmd: "kitten", args: ["@", "--to", k.listenOn, "set-user-vars", "--match", `id:${k.window}`, `crosstalk_state=${state === "off" ? "" : state}`] }, optional: true }
  ];
}
function actionsFor(t, state, platform = process.platform) {
  if (t.tmux?.pane)
    return tmuxActions(t.tmux, state);
  const out = [];
  const k = kindOf2(t);
  if (k === "kitty" && t.kitty)
    out.push(...kittyActions(t.kitty, state));
  else if (k === "iterm" && t.tty)
    out.push({ kind: "tty", path: t.tty, data: itermTabColour(state) + userVar(state) });
  else if (k === "wezterm" && t.tty)
    out.push({ kind: "tty", path: t.tty, data: userVar(state) });
  else if (k === "apple" && t.tty && platform === "darwin")
    out.push({ kind: "apple", tty: t.tty });
  return out;
}
var appleTab = (tty, body) => [
  `if application "Terminal" is running then`,
  `	tell application "Terminal"`,
  `		repeat with w in windows`,
  `			repeat with t in tabs of w`,
  `				if (tty of t) is ${asq2(tty)} then`,
  ...body.map((l) => `					${l}`),
  `				end if`,
  `			end repeat`,
  `		end repeat`,
  `	end tell`,
  `end if`,
  `return ""`
].join(`
`);
var appleReadBgScript = (tty) => appleTab(tty, [`set c to background color of t`, `return ((item 1 of c) as text) & "," & ((item 2 of c) as text) & "," & ((item 3 of c) as text)`]);
var appleSetBgScript = (tty, c) => appleTab(tty, [`set background color of t to {${c.map((n) => Math.round(n)).join(", ")}}`, `return "done"`]);
function parseRgb16(s) {
  const m = /^(\d+),(\d+),(\d+)$/.exec(s.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function appleTint(original, state, amount = 0.25) {
  if (state === "off" || state === "done")
    return original;
  const target = COLOUR[state].map((n) => n * 257);
  return original.map((o, i) => Math.round(o + (target[i] - o) * amount));
}
var dir3 = () => path10.join(P.root, "tabs");
var safe4 = (id) => id.replace(/[^A-Za-z0-9._-]/g, "_");
var fileOf3 = (id) => path10.join(dir3(), `${safe4(id)}.json`);
function readTab(id) {
  try {
    return JSON.parse(fs7.readFileSync(fileOf3(id), "utf8"));
  } catch {
    return null;
  }
}
function writeTab(f) {
  fs7.mkdirSync(dir3(), { recursive: true, mode: 448 });
  const tmp = `${fileOf3(f.sessionId)}.${process.pid}.tmp`;
  fs7.writeFileSync(tmp, JSON.stringify(f), { mode: 384 });
  fs7.renameSync(tmp, fileOf3(f.sessionId));
}
var sleepSync3 = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function withFile(id, fn) {
  fs7.mkdirSync(dir3(), { recursive: true, mode: 448 });
  const lock = `${fileOf3(id)}.lock`;
  let held = false;
  for (let i = 0;i < 50 && !held; i++) {
    try {
      fs7.mkdirSync(lock);
      held = true;
    } catch {
      try {
        if (Date.now() - fs7.statSync(lock).mtimeMs > 5000)
          fs7.rmdirSync(lock);
      } catch {}
      sleepSync3(5);
    }
  }
  try {
    return fn(readTab(id));
  } finally {
    if (held)
      try {
        fs7.rmdirSync(lock);
      } catch {}
  }
}
var MIN_GAP_MS = () => Number(process.env.CROSSTALK_TAB_GAP_MS ?? 750);
function decide(f, now, gap = MIN_GAP_MS()) {
  if (!f || f.applied === f.want)
    return { act: "idle" };
  if (f.appliedAt !== undefined && now - f.appliedAt < gap)
    return { act: "wait", ms: gap - (now - f.appliedAt) };
  return { act: "apply" };
}
function want(o) {
  const now = o.now ?? Date.now();
  const changed = withFile(o.sessionId, (f) => {
    if (!f && o.state === "off")
      return false;
    if (f && f.want === o.state)
      return f.applied !== o.state && now - f.wantAt > 5000;
    writeTab({ ...f ?? { sessionId: o.sessionId }, sessionId: o.sessionId, want: o.state, wantAt: now });
    return true;
  });
  if (changed)
    startApplier(o.sessionId, o.root);
  return changed;
}
function startApplier(id, root) {
  if (process.env.CROSSTALK_TERM_SYNC) {
    applyLoop(id);
    return;
  }
  try {
    const child = spawn5(shim(root), ["term", "apply", "--session", id], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {}
}
var liveSys2 = () => ({
  platform: process.platform,
  run: (s) => {
    const r = spawnSync5(s.cmd, s.args, { input: s.input, encoding: "utf8", timeout: 5000 });
    return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
  },
  writeTty: (p, data) => {
    let fd = -1;
    try {
      fd = fs7.openSync(p, fs7.constants.O_WRONLY | fs7.constants.O_NOCTTY | fs7.constants.O_NONBLOCK);
      return fs7.writeSync(fd, data) === Buffer.byteLength(data);
    } catch {
      return false;
    } finally {
      if (fd >= 0)
        fs7.closeSync(fd);
    }
  },
  term: (id) => readOne2(id)?.terminal ?? null
});
function applyOnce(id, state, f, sys) {
  const t = sys.term(id);
  if (!t)
    return { ok: false };
  let ok = true;
  let appleOriginal = f?.appleOriginal;
  for (const a of actionsFor(t, state, sys.platform)) {
    if (a.kind === "run") {
      const r = sys.run(a.step);
      if (!r.ok && !a.optional)
        ok = false;
    } else if (a.kind === "tty")
      ok = sys.writeTty(a.path, a.data) && ok;
    else {
      if (!appleOriginal && (state === "working" || state === "waiting")) {
        const r = sys.run({ cmd: "osascript", args: ["-"], input: appleReadBgScript(a.tty) });
        if (r.ok && parseRgb16(r.out))
          appleOriginal = r.out.trim();
      }
      const orig = appleOriginal ? parseRgb16(appleOriginal) : null;
      if (!orig)
        continue;
      ok = sys.run({ cmd: "osascript", args: ["-"], input: appleSetBgScript(a.tty, appleTint(orig, state)) }).ok && ok;
    }
  }
  return { ok, appleOriginal };
}
async function applyLoop(id, sys = liveSys2(), sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const lock = `${fileOf3(id)}.applier`;
  const take = () => {
    try {
      fs7.mkdirSync(dir3(), { recursive: true, mode: 448 });
      fs7.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 384 });
      return true;
    } catch {
      try {
        const other = Number(fs7.readFileSync(lock, "utf8"));
        if (other && pidAlive2(other) && other !== process.pid)
          return false;
        fs7.unlinkSync(lock);
        fs7.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 384 });
        return true;
      } catch {
        return false;
      }
    }
  };
  let last = "idle";
  for (let round = 0;round < 3; round++) {
    if (!take())
      return "already applying";
    try {
      for (let i = 0;i < 200; i++) {
        const f = readTab(id);
        const d = decide(f, Date.now());
        if (d.act === "idle")
          break;
        if (d.act === "wait") {
          await sleep(d.ms);
          continue;
        }
        const state = f.want;
        const r = applyOnce(id, state, f, sys);
        last = `${state}${r.ok ? "" : " (partly)"}`;
        withFile(id, (cur) => {
          if (!cur)
            return;
          if (state === "off" && cur.want === "off") {
            try {
              fs7.unlinkSync(fileOf3(id));
            } catch {}
            return;
          }
          writeTab({ ...cur, applied: state, appliedAt: Date.now(), ...r.appleOriginal ? { appleOriginal: r.appleOriginal } : {} });
        });
      }
    } finally {
      try {
        if (Number(fs7.readFileSync(lock, "utf8")) === process.pid)
          fs7.unlinkSync(lock);
      } catch {}
    }
    if (decide(readTab(id), Date.now(), 0).act === "idle")
      break;
  }
  return last;
}
var TMUX_SNIPPET = [
  `# crosstalk: show each agent's state in the window list`,
  `set -ga window-status-format ' #{?#{==:#{@crosstalk_state},waiting},#[fg=colour208]\u25cf waiting#[default],#{?#{==:#{@crosstalk_state},working},#[fg=colour33]\u25cf working#[default],#{?#{==:#{@crosstalk_state},done},#[fg=colour34]\u2713#[default],}}}'`,
  `set -ga window-status-current-format ' #{?#{==:#{@crosstalk_state},waiting},#[fg=colour208]\u25cf waiting#[default],#{?#{==:#{@crosstalk_state},working},#[fg=colour33]\u25cf working#[default],#{?#{==:#{@crosstalk_state},done},#[fg=colour34]\u2713#[default],}}}'`
].join(`
`);
function pendingFor(sessionId, snapshot) {
  try {
    return Object.values(snapshot()).filter((i) => i.sessionId === sessionId && !["answered", "handed", "muted"].includes(i.state)).length;
  } catch {
    return 0;
  }
}

// src/uistate.ts
import fs8 from "node:fs";
import path11 from "node:path";
var FINAL2 = new Set(["answered", "handed", "muted"]);
var file2 = () => path11.join(P.root, "ui.json");
var lockDir2 = () => path11.join(P.root, "ui.lock");
var markers2 = () => path11.join(P.root, "ui-mod");
var safe5 = (id) => id.replace(/[^A-Za-z0-9._-]/g, "_");
var WEEK2 = 7 * 24 * 60 * 60 * 1000;
function read2() {
  try {
    const f = JSON.parse(fs8.readFileSync(file2(), "utf8"));
    if (f && f.v === 1 && f.items && typeof f.items === "object")
      return f;
  } catch {}
  return { v: 1, items: {} };
}
function write2(f) {
  fs8.mkdirSync(P.root, { recursive: true, mode: 448 });
  const tmp = `${file2()}.${process.pid}.tmp`;
  fs8.writeFileSync(tmp, JSON.stringify(f, null, 2), { mode: 384 });
  fs8.renameSync(tmp, file2());
}
var sleepSync4 = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function withStore2(fn) {
  fs8.mkdirSync(P.root, { recursive: true, mode: 448 });
  let held = false;
  for (let i = 0;i < 200 && !held; i++) {
    try {
      fs8.mkdirSync(lockDir2());
      held = true;
    } catch {
      try {
        if (Date.now() - fs8.statSync(lockDir2()).mtimeMs > 1e4)
          fs8.rmdirSync(lockDir2());
      } catch {}
      sleepSync4(10);
    }
  }
  try {
    const f = read2();
    const was = JSON.stringify(f);
    const now = Date.now();
    const out = fn(f.items, now);
    for (const [id, it] of Object.entries(f.items))
      if (FINAL2.has(it.state) && now - it.updatedAt > WEEK2 || now - it.updatedAt > 4 * WEEK2)
        delete f.items[id];
    if (JSON.stringify(f) !== was)
      write2(f);
    return out;
  } finally {
    if (held)
      try {
        fs8.rmdirSync(lockDir2());
      } catch {}
  }
}
function snapshot2() {
  return read2().items;
}
function upsert2(items, it, now) {
  const before = items[it.id];
  if (!before)
    return items[it.id] = { ...it, state: "pending", createdAt: now, updatedAt: now };
  if (FINAL2.has(before.state))
    return before;
  const moved = before.sessionId !== it.sessionId;
  items[it.id] = {
    ...before,
    ...it,
    state: before.state,
    raisedAt: moved ? undefined : before.raisedAt,
    createdAt: before.createdAt,
    updatedAt: moved ? now : before.updatedAt
  };
  return items[it.id];
}
var MARKER_MS2 = 10 * 60 * 1000;
function modActive2(sessionId, now = Date.now()) {
  try {
    return now - fs8.statSync(path11.join(markers2(), safe5(sessionId))).mtimeMs < MARKER_MS2;
  } catch {
    return false;
  }
}

// src/spawn.ts
import fs9 from "node:fs";
import path12 from "node:path";
import { spawnSync as spawnSync6 } from "node:child_process";
var TMUX_SOCKET = "crosstalk";
var dir4 = () => path12.join(P.root, "spawned");
var fileOf4 = (id) => path12.join(dir4(), `${id.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
function readSpawned() {
  let names;
  try {
    names = fs9.readdirSync(dir4()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const f of names)
    try {
      const r = JSON.parse(fs9.readFileSync(path12.join(dir4(), f), "utf8"));
      if (r?.id && r.worktree)
        out.push(r);
    } catch {}
  return out.sort((a, b) => a.createdAt - b.createdAt);
}
function writeSpawned(r) {
  fs9.mkdirSync(dir4(), { recursive: true, mode: 448 });
  const tmp = `${fileOf4(r.id)}.${process.pid}.tmp`;
  fs9.writeFileSync(tmp, JSON.stringify(r, null, 2), { mode: 384 });
  fs9.renameSync(tmp, fileOf4(r.id));
}
function spawnedAt(cwd, recs = readSpawned()) {
  const c = path12.resolve(cwd);
  return recs.find((r) => !r.removedAt && (c === path12.resolve(r.worktree) || c.startsWith(path12.resolve(r.worktree) + path12.sep))) ?? null;
}
var STOP = new Set("a an the on to for and of in with at by from into onto this that it its be is are please can could would you start put get run spin up fire one two three four five six seven eight more another new agent agents session sessions claude someone somebody work working".split(" "));
var TMUX_CONF = [
  `# crosstalk's own tmux server (tmux -L crosstalk), for agents it runs in the background.`,
  `set -g status-left '#[bold]\u25e2 crosstalk#[default] #S  '`,
  `set -g status-left-length 40`,
  `set -g status-right '#{?#{==:#{@crosstalk_state},waiting},#[fg=colour208]\u25cf waiting on you,#{?#{==:#{@crosstalk_state},working},#[fg=colour33]\u25cf working,#{?#{==:#{@crosstalk_state},done},#[fg=colour34]\u2713 done,}}}'`,
  `set -g set-titles on`,
  `set -g set-titles-string '#S'`,
  `set -g detach-on-destroy on`,
  `set -g history-limit 50000`,
  ``
].join(`
`);
function cleanEnv(env) {
  const e = { ...env };
  delete e.TMUX;
  delete e.TMUX_PANE;
  return e;
}
function tmuxHas(name, env = process.env) {
  return spawnSync6("tmux", ["-L", TMUX_SOCKET, "has-session", "-t", `=${name}`], { stdio: "ignore", timeout: 3000, env: cleanEnv(env) }).status === 0;
}
function claim(sessionId, cwd) {
  const rec = spawnedAt(cwd);
  if (!rec)
    return null;
  if (rec.sessionId !== sessionId)
    writeSpawned({ ...rec, sessionId });
  return rec;
}

// src/cleanup.ts
import fs10 from "node:fs";
import path13 from "node:path";
function select(recs, p) {
  const out = [];
  for (const r of recs) {
    if (r.removedAt || !p.exists(r.worktree))
      continue;
    if (!p.ended(r))
      continue;
    if (!p.clean(r.worktree, r.links))
      continue;
    if (!p.branchExists(r.repo, r.branch))
      out.push({ rec: r, why: "deleted" });
    else if (p.merged(r.repo, r.branch, r.base))
      out.push({ rec: r, why: "merged" });
  }
  return out;
}
function defaultBranch(repo, g = git) {
  const o = g(repo, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (o.ok && o.out)
    return o.out.replace(/^origin\//, "");
  for (const b of ["main", "master", "trunk"])
    if (g(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]).ok)
      return b;
  const h = g(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return h.ok && h.out ? h.out : null;
}
function liveProbe(g = git) {
  const defaults = new Map;
  const def = (repo) => {
    if (!defaults.has(repo))
      defaults.set(repo, defaultBranch(repo, g));
    return defaults.get(repo);
  };
  return {
    exists: (p) => fs10.existsSync(p),
    clean: (w, ignore) => {
      const r = g(w, ["status", "--porcelain", "--untracked-files=all"]);
      if (!r.ok)
        return false;
      const skip = new Set(ignore);
      return r.out.split(`
`).filter(Boolean).every((l) => l.startsWith("?? ") && skip.has(l.slice(3).replace(/\/$/, "")));
    },
    branchExists: (repo, b) => g(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]).ok,
    merged: (repo, b, base) => {
      const d = def(repo);
      if (!d || d === b)
        return false;
      const tip = g(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]);
      if (!tip.ok || base && tip.out === base)
        return false;
      const ahead = g(repo, ["rev-list", "--count", `${d}..${b}`]);
      if (!ahead.ok || ahead.out !== "0") {
        const remote = g(repo, ["rev-list", "--count", `origin/${d}..${b}`]);
        if (!remote.ok || remote.out !== "0")
          return false;
      }
      return true;
    },
    ended: (r) => {
      if (r.background && r.tmux && tmuxHas(r.tmux))
        return false;
      const live = readAll2().some((x) => !x.endedAt && path13.resolve(x.cwd).startsWith(path13.resolve(r.worktree)) && recAlive2(x));
      return !live;
    }
  };
}
var cleanupId = (sessionId) => `cleanup:${sessionId}`;
var CLEANUP_OPTIONS = ["Remove them", "Not now"];
function offerFor2(c) {
  const fresh = c.filter((x) => !x.rec.offeredAt);
  if (!fresh.length)
    return null;
  const n = c.length;
  const names = c.slice(0, 4).map((x) => x.rec.name).concat(n > 4 ? ["\u2026"] : []);
  const question = `${n} agent worktree${n === 1 ? " is" : "s are"} done with: ${n === 1 ? "its" : "their"} work is merged and ${n === 1 ? "its session has" : "their sessions have"} ended. Remove ${n === 1 ? "it" : "them"}?`;
  return { count: n, names, question, text: `\u25e2 crosstalk: ${question} (${names.join(", ")}) Say "clean up the worktrees" to do it.` };
}
var stamp = () => path13.join(P.root, "cleanup-stamp");
var CHECK_EVERY_MS = () => Number(process.env.CROSSTALK_CLEANUP_EVERY_MS ?? 10 * 60 * 1000);
function offerOnce2(o = {}) {
  const recs = readSpawned().filter((r) => !r.removedAt);
  if (!recs.length)
    return null;
  if (!o.force) {
    try {
      if (Date.now() - fs10.statSync(stamp()).mtimeMs < CHECK_EVERY_MS())
        return null;
    } catch {}
    fs10.mkdirSync(P.root, { recursive: true, mode: 448 });
    fs10.writeFileSync(stamp(), String(Date.now()), { mode: 384 });
  }
  const c = select(recs, o.probe ?? liveProbe());
  const offer = offerFor2(c);
  if (!offer)
    return null;
  const now = Date.now();
  for (const x of c)
    if (!x.rec.offeredAt)
      writeSpawned({ ...x.rec, offeredAt: now });
  return offer;
}
function surface(sessionId, offer, mod = modActive2(sessionId)) {
  if (!offer)
    return {};
  if (!mod)
    return { systemMessage: offer.text };
  try {
    withStore2((items, now) => upsert2(items, { id: cleanupId(sessionId), kind: "cleanup", sessionId, count: offer.count, names: offer.names, question: offer.question, options: CLEANUP_OPTIONS }, now));
    return {};
  } catch {
    return { systemMessage: offer.text };
  }
}

// src/terminal/hook.ts
function fromHook(o) {
  const out = {};
  if (o.env.CROSSTALK_NO_TERM)
    return out;
  try {
    const current = readTab(o.sessionId)?.want;
    const state = stateForEvent({
      event: o.event,
      pending: /^(Stop|Notification)$/.test(o.event) ? pendingFor(o.sessionId, snapshot2) : 0,
      current,
      notificationType: o.hook?.notification_type,
      message: o.hook?.message
    });
    if (state) {
      want({ sessionId: o.sessionId, state, root: o.root });
      if (drawsProgress(o.env) && o.event !== "SessionEnd")
        out.terminalSequence = progressSequence(state);
    }
  } catch {}
  if (o.isSessionStart && !/^(clear|compact)$/.test(String(o.hook?.source ?? ""))) {
    try {
      const rec = claim(o.sessionId, o.cwd);
      if (rec)
        out.sessionTitle = rec.name;
    } catch {}
    try {
      out.systemMessage = surface(o.sessionId, offerOnce2()).systemMessage;
    } catch {}
  }
  return out;
}

// src/hook.ts
var input = await new Promise((resolve) => {
  let raw = "";
  if (process.stdin.isTTY)
    return resolve("");
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => raw += d);
  process.stdin.on("end", () => resolve(raw));
  process.stdin.on("error", () => resolve(""));
  setTimeout(() => resolve(raw), 2000);
});
var hook = {};
try {
  hook = JSON.parse(input || "{}");
} catch {}
var args = process.argv.slice(2);
var client = (() => {
  const i = args.indexOf("--client");
  return i === -1 ? "" : (args[i + 1] ?? "").toLowerCase();
})();
var positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--client");
var eventName = hook.hook_event_name ?? hook.hookEventName ?? hook.event_name ?? hook.hook_event?.type ?? hook.event_type ?? hook.event ?? positional[0] ?? "SessionStart";
var isAgy = typeof hook.conversationId === "string";
var isKimi = client === "kimi";
var isHermes = /^(pre|post|on)_[a-z_]+$/.test(eventName);
var isGoose = typeof hook.event === "string" && !hook.hook_event_name && !hook.hookEventName;
var isCursor = typeof hook.cursor_version === "string" || Array.isArray(hook.workspace_roots);
var CURSOR_CONTEXT_LIMIT = 1e4;
var sessionId = hook.session_id ?? hook.sessionId ?? hook.thread_id ?? hook.conversation_id ?? hook.conversationId ?? process.env.CLAUDE_CODE_SESSION_ID ?? process.env.ANTIGRAVITY_CONVERSATION_ID;
var isSessionStart = isAgy ? /^PreInvocation$/i.test(eventName) && Number(hook.invocationNum ?? 0) === 0 : isHermes ? /^pre_llm_call$/.test(eventName) && hook.extra?.is_first_turn === true : /^(SessionStart|sessionStart)$/.test(eventName);
var AGENT_DIRS = new Set([".agents", ".agent", "_agents", "_agent"]);
function agyCwd() {
  const ws = hook.workspacePaths;
  if (Array.isArray(ws) && typeof ws[0] === "string" && ws[0])
    return ws[0];
  const here = process.cwd();
  if (AGENT_DIRS.has(path14.basename(here)))
    return path14.dirname(here);
  return here;
}
var cwd = hook.cwd ?? hook.working_dir ?? hook.workspace_roots?.[0] ?? (isAgy ? agyCwd() : process.cwd());
var DELIVERS = isGoose ? /^Stop$/i : isKimi ? /^UserPromptSubmit$/ : isCursor ? /^(sessionStart|beforeSubmitPrompt|preToolUse|postToolUse|postToolUseFailure)$/ : /^(SessionStart|UserPromptSubmit|PreToolUse|PostToolUse|PreInvocation|pre_llm_call)$/i;
var restoreClient = isAgy || isHermes || isGoose || isCursor || isKimi ? null : hook.thread_id || /[\\/]\.codex[\\/]/.test(String(hook.transcript_path ?? "")) ? "codex" : "claude";
var systemMessage;
if (restoreClient && sessionId && !process.env.CROSSTALK_NO_RESTORE) {
  try {
    if (/^UserPromptSubmit$/.test(eventName)) {
      const want = parseShortcut(String(hook.prompt ?? ""));
      if (want) {
        const out = want === "no" ? forget(sessionId) : restore({
          self: sessionId,
          tabs: want !== "windows",
          userAction: true,
          root: rootFrom2(import.meta.url)
        });
        process.stdout.write(JSON.stringify({ decision: "block", reason: out.text }));
        process.exit(0);
      }
    }
    if (!/^(PostToolUse|PreToolUse)$/i.test(eventName))
      note({
        event: eventName,
        sessionId,
        cwd,
        client: restoreClient,
        env: process.env,
        source: hook.source,
        reason: hook.reason
      });
    if (isSessionStart && restoreClient === "claude" && !/^(clear|compact)$/.test(String(hook.source ?? "")))
      systemMessage = restoreSurface(sessionId, askOnceOffer(sessionId, captureTerminal(process.env, process.pid, false))).systemMessage;
  } catch {}
}
if (restoreClient === "claude" && sessionId && !process.env.CROSSTALK_NO_RESTORE && !process.env.CROSSTALK_NO_GATHER) {
  try {
    const fresh = isSessionStart && !/^(clear|compact)$/.test(String(hook.source ?? ""));
    if (fresh)
      watch(sessionId);
    else
      watchThrottled(sessionId);
    const say = systemMessage ? [systemMessage] : [];
    if (fresh) {
      const m = gatherSurface(sessionId, offerOnce(sessionId)).systemMessage;
      if (m)
        say.push(m);
    }
    if (/^(SessionStart|UserPromptSubmit|Stop)$/.test(eventName) && !modActive(sessionId)) {
      const n = takeNote(sessionId);
      if (n)
        say.push(n.text);
    }
    if (say.length)
      systemMessage = say.join(`
`);
  } catch {}
}
var chrome = {};
if (restoreClient === "claude" && sessionId) {
  try {
    chrome = fromHook({ event: eventName, sessionId, cwd, hook, env: process.env, root: rootFrom2(import.meta.url), isSessionStart });
    if (chrome.systemMessage)
      systemMessage = systemMessage ? `${systemMessage}
${chrome.systemMessage}` : chrome.systemMessage;
  } catch {}
}
var chromeOut = (hookSpecific) => {
  const out = {};
  if (chrome.terminalSequence)
    out.terminalSequence = chrome.terminalSequence;
  const title = chrome.sessionTitle && /^(SessionStart|UserPromptSubmit)$/.test(eventName) ? { sessionTitle: chrome.sessionTitle } : {};
  if (hookSpecific || Object.keys(title).length)
    out.hookSpecificOutput = { hookEventName: eventName, ...hookSpecific ?? {}, ...title };
  return out;
};
if (!loadIdentity() || !sessionId) {
  process.stdout.write(JSON.stringify(isGoose ? { decision: "allow" } : isAgy || isHermes || isKimi || isCursor ? {} : { continue: true, ...systemMessage ? { systemMessage } : {}, ...chromeOut() }));
  process.exit(0);
}
var root = rootFrom2(import.meta.url);
var socket = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
async function registerSession() {
  if (!await ensureDaemon(root))
    return;
  let name = `session-${process.ppid}`;
  if (socket) {
    try {
      const dir = path14.join(os6.homedir(), ".claude", "sessions");
      for (const f of fs11.readdirSync(dir)) {
        if (!f.endsWith(".json"))
          continue;
        const e = JSON.parse(fs11.readFileSync(path14.join(dir, f), "utf8"));
        if (e.sessionId === sessionId) {
          name = e.name ?? name;
          break;
        }
      }
    } catch {}
  } else {
    name = hook.thread_name ?? (path14.basename(cwd) || name);
  }
  await request({
    op: "register",
    sessionId,
    pid: process.ppid,
    name,
    cwd,
    socket: socket ?? "",
    transcript: hook.transcript_path ?? hook.transcriptPath,
    .../^post_?tool_?use$/i.test(eventName) ? { touched: pathsFromToolInput(hook.tool_input ?? hook.toolInput ?? hook.tool_args) } : {}
  }).catch(() => {});
}
async function pendingNotice() {
  try {
    const r = await request({ op: "notices", sessionId }, 4000);
    return r?.notice ?? null;
  } catch {
    return null;
  }
}
var say = (extra) => {
  if (isAgy) {
    process.stdout.write(JSON.stringify(extra ? { injectSteps: [{ ephemeralMessage: extra }] } : {}));
    process.exit(0);
  }
  if (isHermes) {
    process.stdout.write(JSON.stringify(extra ? { context: extra } : {}));
    process.exit(0);
  }
  if (isKimi) {
    process.stdout.write(JSON.stringify(extra ? { message: extra } : {}));
    process.exit(0);
  }
  if (isGoose) {
    process.stdout.write(JSON.stringify(extra ? { decision: "block", reason: extra } : { decision: "allow" }));
    process.exit(0);
  }
  if (isCursor) {
    const fits = extra && extra.length > CURSOR_CONTEXT_LIMIT ? extra.slice(0, CURSOR_CONTEXT_LIMIT - 80) + `

[crosstalk trimmed this to fit Cursor]` : extra;
    process.stdout.write(JSON.stringify(fits ? { additional_context: fits } : {}));
    process.exit(0);
  }
  const out = { continue: true, ...chromeOut(extra ? { additionalContext: extra } : undefined) };
  if (systemMessage)
    out.systemMessage = systemMessage;
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
};
if (!isSessionStart && (/^PreInvocation$/i.test(eventName) || /^(pre_llm_call|on_session_start)$/.test(eventName)))
  await registerSession();
if (isSessionStart)
  await registerSession();
if (!DELIVERS.test(eventName))
  say();
if (!isSessionStart)
  await registerSession();
try {
  const opening = await request({ op: "opening", sessionId }, 6000).catch(() => null);
  const [f, t, n] = await Promise.all([
    opening?.opened ? request({ op: "facts", cwd }, 6000).catch(() => null) : null,
    opening?.opened ? request({ op: "tasks" }, 6000).catch(() => null) : null,
    pendingNotice()
  ]);
  const parts = [f?.digest, t?.digest, n].filter(Boolean);
  say(parts.length ? parts.join(`

`) : undefined);
} catch {
  say();
}
