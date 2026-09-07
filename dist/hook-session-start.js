#!/usr/bin/env bun
// @bun
import { createRequire } from "node:module";
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __toESM = (mod, isNodeMode, target) => {
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: () => mod[key],
        enumerable: true
      });
  return to;
};
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/hook-session-start.ts
import path5 from "path";
import os3 from "os";

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

// src/paths.ts
import path3 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var dirOf2 = (metaUrl) => path3.dirname(fileURLToPath2(metaUrl));
var rootFrom2 = (metaUrl) => path3.join(dirOf2(metaUrl), "..");

// src/config.ts
import fs2 from "node:fs";
import os2 from "node:os";
import path4 from "node:path";
var ROOT2 = process.env.CROSSTALK_HOME ?? path4.join(os2.homedir(), ".claude", "crosstalk");
var P2 = {
  root: ROOT2,
  identity: path4.join(ROOT2, "identity.json"),
  peers: path4.join(ROOT2, "peers.json"),
  policy: path4.join(ROOT2, "policy.json"),
  relay: path4.join(ROOT2, "relay.json"),
  queue: path4.join(ROOT2, "queue.json"),
  parked: path4.join(ROOT2, "parked.json"),
  usage: path4.join(ROOT2, "usage.json"),
  daemonSock: path4.join(ROOT2, "daemon.sock"),
  daemonLock: path4.join(ROOT2, "daemon.lock"),
  log: path4.join(ROOT2, "daemon.log")
};
function readJson(file, fallback) {
  try {
    return JSON.parse(fs2.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
var loadIdentity = () => readJson(P2.identity, null);

// src/hook-session-start.ts
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
if (!loadIdentity()) {
  console.log(JSON.stringify({ continue: true }));
  process.exit(0);
}
var root = rootFrom2(import.meta.url);
if (!await ensureDaemon(root)) {
  console.error("crosstalk: daemon would not start; see ~/.claude/crosstalk/daemon.log");
  process.exit(0);
}
var sessionId = hook.session_id ?? process.env.CLAUDE_CODE_SESSION_ID;
var socket = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
if (!sessionId || !socket)
  process.exit(0);
var sessionsDir = path5.join(os3.homedir(), ".claude", "sessions");
var name = `session-${process.ppid}`;
var cwd = hook.cwd ?? process.cwd();
try {
  const fs3 = await import("fs");
  for (const f of fs3.readdirSync(sessionsDir)) {
    if (!f.endsWith(".json"))
      continue;
    const e = JSON.parse(fs3.readFileSync(path5.join(sessionsDir, f), "utf8"));
    if (e.sessionId === sessionId) {
      name = e.name ?? name;
      cwd = e.cwd ?? cwd;
      break;
    }
  }
} catch {}
await request({
  op: "register",
  sessionId,
  pid: process.ppid,
  name,
  cwd,
  socket,
  token: process.env.CLAUDE_CODE_MESSAGING_TOKEN,
  transcript: hook.transcript_path
}).catch(() => {});
