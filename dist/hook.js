#!/usr/bin/env bun
// @bun

// src/hook.ts
import path5 from "path";
import os3 from "os";
import fs3 from "fs";

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
  policy: path.join(ROOT, "policy.json"),
  relay: path.join(ROOT, "relay.json"),
  queue: path.join(ROOT, "queue.json"),
  parked: path.join(ROOT, "parked.json"),
  sessions: path.join(ROOT, "sessions.json"),
  outbox: path.join(ROOT, "outbox.json"),
  usage: path.join(ROOT, "usage.json"),
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
  policy: path3.join(ROOT2, "policy.json"),
  relay: path3.join(ROOT2, "relay.json"),
  queue: path3.join(ROOT2, "queue.json"),
  parked: path3.join(ROOT2, "parked.json"),
  sessions: path3.join(ROOT2, "sessions.json"),
  outbox: path3.join(ROOT2, "outbox.json"),
  usage: path3.join(ROOT2, "usage.json"),
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
var eventName = hook.hook_event_name ?? hook.hookEventName ?? hook.event_name ?? hook.hook_event?.type ?? hook.event_type ?? hook.event ?? process.argv[2] ?? "SessionStart";
var isAgy = typeof hook.conversationId === "string";
var sessionId = hook.session_id ?? hook.sessionId ?? hook.thread_id ?? hook.conversation_id ?? hook.conversationId ?? process.env.CLAUDE_CODE_SESSION_ID ?? process.env.ANTIGRAVITY_CONVERSATION_ID;
var isSessionStart = isAgy ? /^PreInvocation$/i.test(eventName) && Number(hook.invocationNum ?? 0) === 0 : /^SessionStart$/i.test(eventName);
var AGENT_DIRS = new Set([".agents", ".agent", "_agents", "_agent"]);
function agyCwd() {
  const ws = hook.workspacePaths;
  if (Array.isArray(ws) && typeof ws[0] === "string" && ws[0])
    return ws[0];
  const here = process.cwd();
  if (AGENT_DIRS.has(path5.basename(here)))
    return path5.dirname(here);
  return here;
}
var cwd = hook.cwd ?? (isAgy ? agyCwd() : process.cwd());
if (!loadIdentity() || !sessionId) {
  process.stdout.write(JSON.stringify(isAgy ? {} : { continue: true }));
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
      const dir = path5.join(os3.homedir(), ".claude", "sessions");
      for (const f of fs3.readdirSync(dir)) {
        if (!f.endsWith(".json"))
          continue;
        const e = JSON.parse(fs3.readFileSync(path5.join(dir, f), "utf8"));
        if (e.sessionId === sessionId) {
          name = e.name ?? name;
          break;
        }
      }
    } catch {}
  } else {
    name = hook.thread_name ?? (path5.basename(cwd) || name);
  }
  await request({
    op: "register",
    sessionId,
    pid: process.ppid,
    name,
    cwd,
    socket: socket ?? "",
    transcript: hook.transcript_path ?? hook.transcriptPath
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
  const out = { continue: true };
  if (extra) {
    out.hookSpecificOutput = { hookEventName: eventName, additionalContext: extra };
    out.message = extra;
  }
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
};
if (isAgy && !isSessionStart && /^PreInvocation$/i.test(eventName))
  await registerSession();
if (isSessionStart) {
  await registerSession();
  try {
    const [f, t, n] = await Promise.all([
      request({ op: "facts", cwd }, 6000).catch(() => null),
      request({ op: "tasks" }, 6000).catch(() => null),
      socket ? Promise.resolve(null) : pendingNotice()
    ]);
    const parts = [f?.digest, t?.digest, n].filter(Boolean);
    say(parts.length ? parts.join(`

`) : undefined);
  } catch {
    say();
  }
}
say(await pendingNotice() ?? undefined);
