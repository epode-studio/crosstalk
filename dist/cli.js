#!/usr/bin/env bun
// @bun

// src/config.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
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
var DEFAULT_POLICY = {
  default: { delivery: "notify", allowAsk: true },
  peers: {}
};
function ensureRoot() {
  fs.mkdirSync(ROOT, { recursive: true, mode: 448 });
}
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, value) {
  ensureRoot();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 384 });
  fs.renameSync(tmp, file);
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
  const onDisk = readJson(P.identity, null);
  if (onDisk?.storage === "keychain") {
    const full = keychain.read();
    if (full)
      return full;
    return null;
  }
  return onDisk;
};
var saveIdentity = (id) => writeJson(P.identity, id);
function secureIdentity() {
  if (!keychain.available())
    return { moved: false, reason: "the keychain is macOS only" };
  const current = loadIdentity();
  if (!current)
    return { moved: false, reason: "no identity yet" };
  const onDisk = readJson(P.identity, {});
  if (onDisk.storage === "keychain")
    return { moved: false, reason: "already in the keychain" };
  keychain.write(current);
  if (JSON.stringify(keychain.read()) !== JSON.stringify(current))
    return { moved: false, reason: "the keychain did not return what was written" };
  writeJson(P.identity, {
    storage: "keychain",
    label: current.label,
    ed: { pub: current.ed.pub, priv: "" },
    x: { pub: current.x.pub, priv: "" },
    createdAt: current.createdAt
  });
  return { moved: true };
}
var loadPeers = () => readJson(P.peers, {});
var savePeers = (peers) => writeJson(P.peers, peers);
var loadPolicy = () => {
  const p = readJson(P.policy, DEFAULT_POLICY);
  return { default: { ...DEFAULT_POLICY.default, ...p.default }, peers: p.peers ?? {} };
};
var savePolicy = (p) => writeJson(P.policy, p);
function policyFor(label, policy = loadPolicy()) {
  return { ...policy.default, ...policy.peers[label] ?? {} };
}
var loadRelay = () => readJson(P.relay, {
  url: process.env.CROSSTALK_RELAY ?? "wss://crosstalk-relay.billowing-poetry-4cd6.workers.dev"
});
var saveRelay = (url, pub) => {
  const current = loadRelay();
  writeJson(P.relay, { url, pub: pub ?? (url === current.url ? current.pub : undefined) });
};

// src/crypto.ts
import crypto from "node:crypto";
var b64 = (b) => Buffer.from(b).toString("base64");
var un64 = (s) => Buffer.from(s, "base64");
function newIdentity(label) {
  const ed = crypto.generateKeyPairSync("ed25519");
  const x = crypto.generateKeyPairSync("x25519");
  return {
    label,
    ed: {
      pub: b64(ed.publicKey.export({ type: "spki", format: "der" })),
      priv: b64(ed.privateKey.export({ type: "pkcs8", format: "der" }))
    },
    x: {
      pub: b64(x.publicKey.export({ type: "spki", format: "der" })),
      priv: b64(x.privateKey.export({ type: "pkcs8", format: "der" }))
    },
    createdAt: Date.now()
  };
}
function fingerprint(edPubB64) {
  const h = crypto.createHash("sha256").update(un64(edPubB64)).digest("hex");
  return h.slice(0, 16).match(/.{4}/g).join("-");
}
function seal(key, plaintext) {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return b64(Buffer.concat([nonce, c.getAuthTag(), ct]));
}
function open(key, sealed) {
  const raw = un64(sealed);
  const d = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}
var WORDS = [
  "otter",
  "heron",
  "marten",
  "kestrel",
  "badger",
  "lynx",
  "raven",
  "stoat",
  "puffin",
  "curlew",
  "osprey",
  "hare",
  "adder",
  "newt",
  "shrew",
  "weasel",
  "falcon",
  "gannet",
  "fulmar",
  "dipper",
  "wagtail",
  "siskin",
  "linnet",
  "merlin",
  "harrier",
  "teal",
  "widgeon",
  "brambling",
  "redwing",
  "fieldfare",
  "chough",
  "jackdaw",
  "rook",
  "swift",
  "martin",
  "dunlin",
  "godwit",
  "avocet",
  "bittern",
  "egret",
  "salmon",
  "trout",
  "perch",
  "tench",
  "bream",
  "chub",
  "dace",
  "roach",
  "gudgeon",
  "minnow",
  "mackerel",
  "herring",
  "pollock",
  "haddock",
  "turbot",
  "brill",
  "plaice",
  "dab",
  "sprat",
  "whiting",
  "beetle",
  "cricket",
  "mayfly",
  "damsel",
  "hornet",
  "mason",
  "carder",
  "miner",
  "tiger",
  "emerald",
  "moth",
  "hawkmoth",
  "lackey",
  "vapourer",
  "cinnabar",
  "burnet",
  "forester",
  "chimney",
  "ghost",
  "drinker",
  "basalt",
  "granite",
  "gabbro",
  "dolerite",
  "gneiss",
  "schist",
  "slate",
  "shale",
  "chalk",
  "flint",
  "quartz",
  "feldspar",
  "mica",
  "olivine",
  "garnet",
  "zircon",
  "topaz",
  "beryl",
  "jasper",
  "agate",
  "onyx",
  "opal",
  "amber",
  "jet",
  "pearl",
  "coral",
  "nacre",
  "ivory",
  "horn",
  "antler",
  "copper",
  "pewter",
  "bronze",
  "brass",
  "nickel",
  "cobalt",
  "zinc",
  "tungsten",
  "titanium",
  "platinum",
  "linen",
  "hessian",
  "canvas",
  "denim",
  "tweed",
  "worsted",
  "velvet",
  "satin",
  "muslin",
  "calico",
  "oak",
  "ash",
  "elm",
  "beech",
  "rowan",
  "alder",
  "hazel",
  "willow",
  "holly",
  "yew",
  "cedar",
  "larch",
  "spruce",
  "juniper",
  "hawthorn",
  "blackthorn",
  "walnut",
  "cherry",
  "maple",
  "poplar",
  "ochre",
  "umber",
  "sienna",
  "indigo",
  "madder",
  "woad",
  "cochineal",
  "verdigris",
  "orpiment",
  "thunder",
  "squall",
  "gale",
  "breeze",
  "zephyr",
  "monsoon",
  "cyclone",
  "tempest",
  "drizzle",
  "downpour",
  "blizzard",
  "flurry",
  "frost",
  "rime",
  "glaze",
  "thaw",
  "dew",
  "mist",
  "fogbank",
  "haze",
  "smog",
  "cumulus",
  "cirrus",
  "stratus",
  "nimbus",
  "estuary",
  "fjord",
  "lagoon",
  "atoll",
  "reef",
  "shoal",
  "spit",
  "cove",
  "inlet",
  "channel",
  "narrows",
  "sound",
  "firth",
  "loch",
  "tarn",
  "mere",
  "brook",
  "torrent",
  "cascade",
  "cataract",
  "rapid",
  "eddy",
  "whirlpool",
  "surge",
  "swell",
  "moorland",
  "heath",
  "fenland",
  "marsh",
  "bog",
  "mire",
  "meadow",
  "pasture",
  "coppice",
  "thicket",
  "ridgeline",
  "corrie",
  "gully",
  "ravine",
  "canyon",
  "plateau",
  "summit",
  "saddle",
  "col",
  "anvil",
  "bellows",
  "forge",
  "crucible",
  "tongs",
  "chisel",
  "mallet",
  "plane",
  "auger",
  "gimlet",
  "lathe",
  "spindle",
  "bobbin",
  "shuttle",
  "loom",
  "treadle",
  "flywheel",
  "gearwheel",
  "ratchet",
  "pawl",
  "compass",
  "sextant",
  "calliper",
  "vernier",
  "lantern",
  "beacon",
  "brazier",
  "taper"
];
var newPhrase = (words = 4) => Array.from({ length: words }, () => WORDS[crypto.randomInt(WORDS.length)]).join("-");
var normalisePhrase = (p) => p.trim().toLowerCase().replace(/\s+/g, "-").replace(/-+/g, "-");
var codeForPhrase = (phrase) => crypto.createHash("sha256").update("crosstalk/room/" + normalisePhrase(phrase)).digest("hex").slice(0, 12).toUpperCase();
var pairingKey = (phrase) => crypto.pbkdf2Sync(normalisePhrase(phrase), "crosstalk/pair/v2", 200000, 32, "sha256");
var sealOffer = (phrase, offer) => seal(pairingKey(phrase), JSON.stringify(offer));
var openOffer = (phrase, blob) => JSON.parse(open(pairingKey(phrase), blob));
var asPeer = (o) => ({
  label: o.label,
  machine: o.machine,
  edPub: o.edPub,
  xPub: o.xPub,
  fingerprint: fingerprint(o.edPub),
  pairedAt: Date.now()
});

// src/crypto.ts
var normalisePhrase2 = (p) => p.trim().toLowerCase().replace(/\s+/g, "-").replace(/-+/g, "-");

// src/invite.ts
var DEFAULT_PORT = 8787;
function formatInvite(phrase, where, port) {
  if (!where)
    return phrase;
  const suffix = port === DEFAULT_PORT ? "" : `:${port}`;
  return `${phrase} at ${where}${suffix}`;
}
function parseInvite(input) {
  const raw = input.trim().replace(/^["']|["']$/g, "");
  const [left, right] = raw.split(/\s+at\s+|\s*@\s*/i).map((s) => s?.trim());
  const phrase = normalisePhrase2(left ?? "");
  if (!phrase || phrase.split("-").length < 3)
    throw new Error(`"${input}" does not look like a pairing phrase (expected four words)`);
  if (!right)
    return { phrase };
  const m = right.match(/^(.*?)(?::(\d{2,5}))?$/);
  return { phrase, where: m?.[1] || right, port: m?.[2] ? Number(m[2]) : DEFAULT_PORT };
}

// src/net.ts
import os2 from "node:os";
import { execFileSync as execFileSync2 } from "node:child_process";
function tailscaleName() {
  for (const bin of ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) {
    try {
      const out = execFileSync2(bin, ["status", "--json"], { encoding: "utf8", timeout: 3000 });
      const dns = JSON.parse(out)?.Self?.DNSName;
      const short = dns?.replace(/\.$/, "").split(".")[0];
      if (short)
        return short.toLowerCase();
    } catch {}
  }
  return null;
}
function tailscale() {
  for (const bin of ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) {
    try {
      const out = execFileSync2(bin, ["ip", "-4"], { encoding: "utf8", timeout: 2000 }).trim();
      const ip = out.split(`
`)[0]?.trim();
      if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip))
        return ip;
    } catch {}
  }
  return null;
}
function lan() {
  const best = [];
  for (const addrs of Object.values(os2.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal)
        continue;
      if (a.address.startsWith("169.254."))
        continue;
      best.push(a.address);
    }
  }
  return best.find((a) => a.startsWith("192.168.")) ?? best.find((a) => a.startsWith("10.")) ?? best.find((a) => /^172\.(1[6-9]|2\d|3[01])\./.test(a)) ?? best[0] ?? null;
}
function bestAddress() {
  const forced = process.env.CROSSTALK_ADDRESS;
  if (forced)
    return { host: forced, kind: "lan", note: "set by you" };
  const ts = tailscale();
  if (ts)
    return { host: ts, kind: "tailscale", note: "over your tailnet, from anywhere" };
  const l = lan();
  if (l)
    return { host: l, kind: "lan", note: "same network only" };
  return { host: "127.0.0.1", kind: "loopback", note: "this machine only" };
}
function allAddresses() {
  const out = [];
  const ts = tailscale();
  if (ts)
    out.push({ host: ts, kind: "tailscale", note: "over your tailnet, from anywhere" });
  for (const addrs of Object.values(os2.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal)
        continue;
      if (a.address.startsWith("169.254."))
        continue;
      if (out.some((x) => x.host === a.address))
        continue;
      out.push({ host: a.address, kind: "lan", note: "same network only" });
    }
  }
  return out;
}
function machineName() {
  const clean = (s) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);
  if (process.platform === "darwin") {
    try {
      const name = execFileSync2("scutil", ["--get", "ComputerName"], {
        encoding: "utf8",
        timeout: 2000
      });
      const c = clean(name).replace(/^[a-z]+-?s-/, "");
      if (c)
        return c;
    } catch {}
  }
  return clean(os2.hostname().split(".")[0]) || "machine";
}
function userName() {
  const first = (s) => s.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z0-9-]/g, "");
  for (const get of [
    () => execFileSync2("git", ["config", "user.name"], { encoding: "utf8", timeout: 2000 }),
    () => process.platform === "darwin" ? execFileSync2("id", ["-F"], { encoding: "utf8", timeout: 2000 }) : "",
    () => process.env.USER ?? ""
  ]) {
    try {
      const v = first(get());
      if (v && v.length > 1)
        return v;
    } catch {}
  }
  return "me";
}
function bonjourName() {
  if (process.platform === "darwin") {
    try {
      const n = execFileSync2("scutil", ["--get", "LocalHostName"], {
        encoding: "utf8",
        timeout: 2000
      }).trim();
      if (n)
        return n.toLowerCase();
    } catch {}
  }
  const h = os2.hostname().split(".")[0];
  return h ? h.toLowerCase() : null;
}
async function bonjourWorks(port, timeoutMs = 2000) {
  const name = bonjourName();
  if (!name)
    return null;
  try {
    const r = await fetch(`http://${name}.local:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    return r.ok ? name : null;
  } catch {
    return null;
  }
}
async function whereToSay(port) {
  const ts = tailscaleName();
  if (ts)
    return { token: ts, reach: "anywhere", how: "over your tailnet" };
  const bonjour = await bonjourWorks(port);
  if (bonjour)
    return { token: bonjour, reach: "same network", how: "this machine's name on the network" };
  const addr = bestAddress();
  if (addr.kind === "loopback")
    return { token: addr.host, reach: "same machine", how: "no network address found" };
  return { token: addr.host, reach: "same network", how: "this machine's address" };
}
function expandAddress(token, port) {
  const t = token.trim().replace(/^@/, "").trim();
  const out = [];
  const add = (u) => {
    if (u && !out.includes(u))
      out.push(u);
  };
  if (/^https?:\/\//i.test(t)) {
    add(t.replace(/^http/, "ws").replace(/\/$/, ""));
    return out;
  }
  if (/\./.test(t) && /[a-z]/i.test(t)) {
    add(t.endsWith("trycloudflare.com") ? `wss://${t}` : `ws://${t}:${port}`);
    return out;
  }
  if (/^[a-z0-9][a-z0-9-]*$/i.test(t) && !/^\d+$/.test(t)) {
    add(`ws://${t}:${port}`);
    add(`ws://${t}.local:${port}`);
    add(`wss://${t}.trycloudflare.com`);
    return out;
  }
  const mine = bestAddress().host;
  const parts = mine.split(".");
  if (/^\d{1,3}$/.test(t) && parts.length === 4)
    add(`ws://${parts[0]}.${parts[1]}.${parts[2]}.${t}:${port}`);
  if (/^\d{1,3}\.\d{1,3}$/.test(t) && parts.length === 4)
    add(`ws://${parts[0]}.${parts[1]}.${t}:${port}`);
  add(`ws://${t}:${port}`);
  return out;
}

// src/client.ts
import net from "node:net";
import fs2 from "node:fs";
import { spawn } from "node:child_process";

// src/config.ts
import os3 from "node:os";
import path2 from "node:path";
var ROOT2 = process.env.CROSSTALK_HOME ?? path2.join(os3.homedir(), ".claude", "crosstalk");
var P2 = {
  root: ROOT2,
  identity: path2.join(ROOT2, "identity.json"),
  peers: path2.join(ROOT2, "peers.json"),
  policy: path2.join(ROOT2, "policy.json"),
  relay: path2.join(ROOT2, "relay.json"),
  queue: path2.join(ROOT2, "queue.json"),
  parked: path2.join(ROOT2, "parked.json"),
  sessions: path2.join(ROOT2, "sessions.json"),
  outbox: path2.join(ROOT2, "outbox.json"),
  usage: path2.join(ROOT2, "usage.json"),
  daemonSock: path2.join(ROOT2, "daemon.sock"),
  daemonLock: path2.join(ROOT2, "daemon.lock"),
  log: path2.join(ROOT2, "daemon.log")
};

// src/paths.ts
import path3 from "node:path";
import { fileURLToPath } from "node:url";
var dirOf = (metaUrl) => path3.dirname(fileURLToPath(metaUrl));
var rootFrom = (metaUrl) => path3.join(dirOf(metaUrl), "..");
var shim = (root) => path3.join(root, "bin", "crosstalk");

// src/client.ts
function request(req, timeoutMs = 130000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(P2.daemonSock);
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
    const pid = Number(fs2.readFileSync(P2.daemonLock, "utf8"));
    process.kill(pid, 0);
    return fs2.existsSync(P2.daemonSock);
  } catch {
    return false;
  }
}
async function ensureDaemon(root = rootFrom(import.meta.url)) {
  if (daemonRunning())
    return true;
  const out = fs2.openSync(P2.log, "a");
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

// src/tunnel.ts
import { spawn as spawn2, execFileSync as execFileSync3 } from "node:child_process";
import fs3 from "node:fs";
import os4 from "node:os";
import path4 from "node:path";
var BIN_DIR = path4.join(ROOT2, "bin");
var LOCAL_BIN = path4.join(BIN_DIR, "cloudflared");
function onPath() {
  for (const candidate of [LOCAL_BIN, "cloudflared"]) {
    try {
      execFileSync3(candidate, ["--version"], { stdio: "ignore", timeout: 4000 });
      return candidate;
    } catch {}
  }
  return null;
}
function assetName() {
  const arch = os4.arch() === "arm64" ? "arm64" : os4.arch() === "x64" ? "amd64" : null;
  if (!arch)
    return null;
  if (process.platform === "darwin")
    return `cloudflared-darwin-${arch}.tgz`;
  if (process.platform === "linux")
    return `cloudflared-linux-${arch}`;
  return null;
}
async function ensureCloudflared(onProgress) {
  const existing = onPath();
  if (existing)
    return existing;
  const asset = assetName();
  if (!asset)
    return null;
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`;
  onProgress?.(`fetching cloudflared for ${process.platform} ${os4.arch()}`);
  fs3.mkdirSync(BIN_DIR, { recursive: true, mode: 448 });
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok)
    return null;
  const bytes = Buffer.from(await res.arrayBuffer());
  if (asset.endsWith(".tgz")) {
    const tmp = path4.join(BIN_DIR, "cloudflared.tgz");
    fs3.writeFileSync(tmp, bytes);
    execFileSync3("tar", ["-xzf", tmp, "-C", BIN_DIR], { timeout: 60000 });
    fs3.rmSync(tmp, { force: true });
  } else {
    fs3.writeFileSync(LOCAL_BIN, bytes);
  }
  try {
    fs3.chmodSync(LOCAL_BIN, 493);
  } catch {}
  return onPath();
}
async function openTunnel(bin, port, logPath, timeoutMs = 60000) {
  fs3.writeFileSync(logPath, "");
  const out = fs3.openSync(logPath, "a");
  const child = spawn2(bin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], {
    detached: true,
    stdio: ["ignore", out, out]
  });
  child.unref();
  const deadline = Date.now() + timeoutMs;
  let found = null;
  while (Date.now() < deadline) {
    try {
      found = fs3.readFileSync(logPath, "utf8").match(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com/i);
    } catch {}
    if (found)
      break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!found) {
    try {
      process.kill(child.pid);
    } catch {}
    throw new Error(`cloudflared printed no URL. See ${logPath}`);
  }
  const host = `${found[1]}.trycloudflare.com`;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`https://${host}/health`, { signal: AbortSignal.timeout(4000) });
      if (r.ok)
        return { url: found[0], host, subdomain: found[1], pid: child.pid };
    } catch {}
    await new Promise((r) => setTimeout(r, 1500));
  }
  try {
    process.kill(child.pid);
  } catch {}
  throw new Error(`the tunnel at ${host} never carried traffic. See ${logPath}`);
}

// src/usage.ts
import fs4 from "node:fs";
import path5 from "node:path";
var FILE = path5.join(ROOT2, "usage.json");
function load() {
  try {
    return JSON.parse(fs4.readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}
var estTokens = (chars) => Math.round(chars / 4);
function summarise(u = load()) {
  const rows = Object.entries(u).map(([peer, p]) => ({
    peer,
    sent: p.sentMessages,
    received: p.recvMessages,
    deliveredToClaude: p.recvDelivered,
    estTokensOut: estTokens(p.sentChars),
    estTokensIn: estTokens(p.recvChars),
    since: p.firstAt
  }));
  return {
    rows,
    totals: {
      sent: rows.reduce((a, r) => a + r.sent, 0),
      received: rows.reduce((a, r) => a + r.received, 0),
      estTokensOut: rows.reduce((a, r) => a + r.estTokensOut, 0),
      estTokensIn: rows.reduce((a, r) => a + r.estTokensIn, 0)
    }
  };
}

// src/trust.ts
import fs5 from "node:fs";
import path6 from "node:path";
var LEVELS = ["mute", "notify", "ask", "handoff", "deliver"];
var isLevel = (s) => LEVELS.includes(s);
var DESCRIPTION = {
  mute: "nothing reaches you",
  notify: "a line on your screen; their words stay behind a tool call",
  ask: "also a question that costs you a turn",
  handoff: "also a work item with state and files",
  deliver: "also their words inside your turn"
};
var FILE2 = path6.join(ROOT2, "trust.json");
var DEFAULT_TRUST = {
  rooms: {},
  people: {},
  default: "ask",
  muted: {}
};
var ROOM_DEFAULT = "notify";
function load2() {
  try {
    const raw = JSON.parse(fs5.readFileSync(FILE2, "utf8"));
    return {
      rooms: raw.rooms ?? {},
      people: raw.people ?? {},
      default: isLevel(raw.default) ? raw.default : DEFAULT_TRUST.default,
      muted: raw.muted ?? {}
    };
  } catch {
    return migrate();
  }
}
function save(t) {
  fs5.mkdirSync(ROOT2, { recursive: true, mode: 448 });
  const tmp = `${FILE2}.tmp`;
  fs5.writeFileSync(tmp, JSON.stringify(t, null, 2), { mode: 384 });
  fs5.renameSync(tmp, FILE2);
}
function migrate() {
  const t = { ...DEFAULT_TRUST, rooms: {}, people: {}, muted: {} };
  try {
    const old = JSON.parse(fs5.readFileSync(path6.join(ROOT2, "policy.json"), "utf8"));
    const asLevel = (p) => p?.delivery === "deliver" ? "deliver" : p?.delivery === "quiet" ? "notify" : p?.allowAsk ? "ask" : "notify";
    if (old?.default)
      t.default = asLevel(old.default);
    for (const [name, p] of Object.entries(old?.peers ?? {})) {
      t.people[name] = asLevel(p);
      if (p.mutedUntil)
        t.muted[name] = p.mutedUntil;
    }
    save(t);
  } catch {}
  return t;
}

// src/paths.ts
import path7 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var dirOf2 = (metaUrl) => path7.dirname(fileURLToPath2(metaUrl));
var rootFrom2 = (metaUrl) => path7.join(dirOf2(metaUrl), "..");
var shim2 = (root) => path7.join(root, "bin", "crosstalk");

// src/cli.ts
import fs6 from "fs";
import path8 from "path";
import { spawn as spawn3, execFileSync as execFileSync4 } from "child_process";
var argv = process.argv.slice(2);
var cmd = argv[0] ?? "status";
var VALUE_FLAGS = new Set(["--label", "--phrase", "--relay", "--port", "--address"]);
var DEFAULT_RELAY = process.env.CROSSTALK_DEFAULT_RELAY ?? "wss://crosstalk-relay.billowing-poetry-4cd6.workers.dev";
var flag = (f, d) => {
  const i = argv.indexOf(f);
  return i === -1 ? d : argv[i + 1];
};
var has = (f) => argv.includes(f);
var positional = (() => {
  const out = [];
  for (let i = 1;i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      if (VALUE_FLAGS.has(a))
        i++;
      continue;
    }
    out.push(a);
  }
  return out;
})();
var ROOT_DIR = rootFrom2(import.meta.url);
var RELAY_PID = path8.join(ROOT, "relay.pid");
var TUNNEL_PID = path8.join(ROOT, "tunnel.pid");
var httpBase = (ws = loadRelay().url) => ws.replace(/^ws/, "http").replace(/\/ws$/, "");
var die = (m) => {
  console.error(m);
  process.exit(1);
};
var ago = (ts) => {
  if (!ts)
    return "never";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60)
    return `${s}s ago`;
  if (s < 3600)
    return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};
function identityOrCreate() {
  const existing = loadIdentity();
  if (existing)
    return existing;
  const label = flag("--label") ?? userName();
  const id = { ...newIdentity(label), machine: machineName() };
  saveIdentity(id);
  console.log(`you are "${label}" on "${id.machine}"   ${fingerprint(id.ed.pub)}`);
  console.log(`change it any time with /crosstalk:rename me <name>`);
  return id;
}
var relayPid = () => {
  try {
    const pid = Number(fs6.readFileSync(RELAY_PID, "utf8"));
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
};
async function relayPubkey(url = loadRelay().url, ms = 2000) {
  try {
    const r = await fetch(`${httpBase(url)}/pubkey`, { signal: AbortSignal.timeout(ms) });
    if (!r.ok)
      return;
    return (await r.json()).pub;
  } catch {
    return;
  }
}
async function relayReachable(url = loadRelay().url, ms = 1500) {
  try {
    const c = AbortSignal.timeout(ms);
    const r = await fetch(`${httpBase(url)}/health`, { signal: c });
    return r.ok;
  } catch {
    return false;
  }
}
async function startRelay(port = Number(flag("--port", "8787"))) {
  if (has("--address"))
    process.env.CROSSTALK_ADDRESS = flag("--address");
  const addr = bestAddress();
  if (relayPid()) {
    const url2 = loadRelay().url;
    if (await relayReachable(url2))
      return url2;
  }
  const out = fs6.openSync(path8.join(ROOT, "relay.log"), "a");
  const child = spawn3(shim2(ROOT_DIR), ["relay", "--host", "0.0.0.0", "--port", String(port)], {
    detached: true,
    stdio: ["ignore", out, out]
  });
  child.unref();
  fs6.mkdirSync(ROOT, { recursive: true, mode: 448 });
  fs6.writeFileSync(RELAY_PID, String(child.pid), { mode: 384 });
  const url = `ws://${addr.host}:${port}`;
  saveRelay(url);
  for (let i = 0;i < 40; i++) {
    if (await relayReachable(url, 500))
      break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (has("--public")) {
    const bin = await ensureCloudflared((n) => console.log(n));
    if (!bin)
      die(`could not get cloudflared, which --public needs.
Install it yourself (brew install cloudflared) and try again, or drop --public
and pair on the same network.`);
    console.log("opening a public tunnel, this takes a few seconds");
    try {
      const t = await openTunnel(bin, port, path8.join(ROOT, "tunnel.log"));
      fs6.writeFileSync(TUNNEL_PID, String(t.pid), { mode: 384 });
      saveRelay(`wss://${t.host}`);
      console.log(`relay reachable at ${t.url}`);
      return `wss://${t.host}`;
    } catch (e) {
      die(`the tunnel did not come up: ${e.message}
See ${path8.join(ROOT, "tunnel.log")}`);
    }
  }
  console.log(`relay running on ${url}   (${addr.kind}, ${addr.note})`);
  const others = allAddresses().filter((a) => a.host !== addr.host);
  if (others.length)
    console.log(`other addresses this machine has: ${others.map((a) => a.host).join(", ")}
If they cannot reach ${addr.host}, redo with --address <one of those>.`);
  return url;
}
async function relay() {
  const sub = positional[0] ?? "status";
  if (sub === "stop") {
    const pid = relayPid();
    if (!pid)
      return console.log("no relay started by crosstalk is running");
    process.kill(pid, "SIGTERM");
    fs6.rmSync(RELAY_PID, { force: true });
    try {
      process.kill(Number(fs6.readFileSync(TUNNEL_PID, "utf8")), "SIGTERM");
      fs6.rmSync(TUNNEL_PID, { force: true });
      console.log("tunnel closed");
    } catch {}
    return console.log("relay stopped");
  }
  if (sub === "start") {
    await startRelay();
    return;
  }
  const url = loadRelay().url;
  console.log(`configured  ${url}`);
  console.log(`reachable   ${await relayReachable(url) ? "yes" : "no"}`);
  console.log(`local pid   ${relayPid() ?? "none started by crosstalk"}`);
}
var myOffer = async (id) => ({
  label: id.label,
  machine: id.machine ?? machineName(),
  edPub: id.ed.pub,
  xPub: id.x.pub
});
function adoptPeer(peer) {
  const peers = loadPeers();
  const taken = (name) => peers[name] && peers[name].fingerprint !== peer.fingerprint;
  let label = peer.label;
  if (taken(label)) {
    const byMachine = peer.machine ? `${peer.label}-${peer.machine}` : "";
    if (byMachine && !taken(byMachine))
      label = byMachine;
    else {
      let i = 2;
      while (taken(`${peer.label}-${i}`))
        i++;
      label = `${peer.label}-${i}`;
    }
    console.log(`
You already have a "${peer.label}" (${peers[peer.label].fingerprint}), so this one is "${label}".
Rename it with /crosstalk:rename ${label} <name>.`);
  }
  peers[label] = { ...peer, label };
  savePeers(peers);
  return label;
}
async function pair() {
  if (has("--relay"))
    saveRelay(flag("--relay"));
  const id = identityOrCreate();
  const joining = positional.join(" ").trim();
  if (joining) {
    const inv = parseInvite(joining);
    const code2 = codeForPhrase(inv.phrase);
    if (inv.where) {
      const port2 = inv.port ?? 8787;
      const tried = [];
      let found = null;
      for (const candidate of expandAddress(inv.where, port2)) {
        tried.push(candidate);
        if (await relayReachable(candidate, 3000)) {
          found = candidate;
          break;
        }
      }
      if (!found)
        die(`nothing is answering as "${inv.where}".

Tried: ${tried.join(", ")}

Their machine has to be awake, and you have to be able to reach it: the same
network, or both on the same tailnet. Ask them what /crosstalk:pair --host
printed, including the part after "at".`);
      saveRelay(found);
    }
    if (!await relayReachable())
      die(`cannot reach a relay at ${httpBase()}.`);
    const r = await fetch(`${httpBase()}/pair/${code2}?side=offer`);
    if (!r.ok)
      die(r.status === 429 ? "the relay is rate-limiting pairing attempts; wait a minute" : `no invite matches "${inv.phrase}". Check the words, or ask for a new one, invites last 15 minutes.`);
    const { blob } = await r.json();
    let peer, offerRelayPub;
    try {
      const raw = openOffer(inv.phrase, blob);
      offerRelayPub = raw.relayPub;
      peer = asPeer(raw);
    } catch {
      return die(`could not open that invite. The words are probably slightly off.`);
    }
    const localName = adoptPeer(peer);
    peer.label = localName;
    const advertised = peer.relayPub ?? offerRelayPub;
    if (advertised)
      saveRelay(loadRelay().url, advertised);
    const post = await fetch(`${httpBase()}/pair/${code2}?side=reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blob: sealOffer(inv.phrase, await myOffer(id)) })
    });
    if (!post.ok)
      die("could not send the pairing reply");
    await ensureDaemon(ROOT_DIR);
    console.log(`
Paired with "${peer.label}".

  them  ${peer.fingerprint}
  you   ${fingerprint(id.ed.pub)}

Read both to each other. If they match, nobody is in the middle.

They start at "ask": they can put a line on your screen, and their agent can ask
yours a question. Their words never enter your session unless you raise them.

  /crosstalk:trust`);
    return;
  }
  const url = has("--host") ? await startRelay() : loadRelay().url;
  if (!await relayReachable(url))
    die(`no relay at ${httpBase(url)}.

Run this instead and crosstalk will host one for you:
  /crosstalk:pair --host`);
  const phrase = flag("--phrase") ?? newPhrase();
  const code = codeForPhrase(phrase);
  const relayPub = await relayPubkey(url);
  if (relayPub)
    saveRelay(url, relayPub);
  const res = await fetch(`${httpBase(url)}/pair/${code}?side=offer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ blob: sealOffer(phrase, { ...await myOffer(id), relayPub }) })
  });
  if (!res.ok)
    die(`the relay at ${httpBase(url)} refused the pairing offer`);
  const asHttp = new URL(url.replace(/^ws/, "http"));
  const port = Number(asHttp.port || (asHttp.protocol === "https:" ? 443 : 8787));
  const tunnelSub = asHttp.hostname.endsWith(".trycloudflare.com") ? asHttp.hostname.replace(".trycloudflare.com", "") : null;
  const where = url === DEFAULT_RELAY ? null : tunnelSub ? { token: tunnelSub, reach: "anywhere", how: "a throwaway tunnel" } : await whereToSay(port);
  const invite = formatInvite(phrase, where?.token ?? null, port);
  const reachNote = !where ? `They can be anywhere. Both of you reach the same relay, which routes
ciphertext and holds no key that opens it.` : where.reach === "anywhere" ? "They can be anywhere." : where?.reach === "same network" ? `They have to be on the same network as you. For anywhere, put both machines on
a tailnet with Tailscale and run this again, or host a relay: see deploy/.` : "No network address was found, so nothing outside this machine can reach it.";
  const tunnelNote = tunnelSub ? `
This address only lasts as long as this tunnel. Close it and the two of you stop
reaching each other, and pairing again gives a different one. For something that
lasts, run a relay: see deploy/.` : "";
  console.log(`
Tell them these words:

    ${invite}

They run  /crosstalk:pair ${invite}

Say it out loud, or send it somewhere you already trust. Not through the relay.
Whoever has these words can pair with you until they expire.

  you       ${id.label}  ${fingerprint(id.ed.pub)}
  reaches   ${where?.reach ?? "anywhere"}${where ? `  (${where.how})` : ""}
  expires   15 minutes

${reachNote}${tunnelNote}

Waiting\u2026`);
  for (let i = 0;i < 900; i++) {
    const r = await fetch(`${httpBase(url)}/pair/${code}?side=reply`).catch(() => null);
    if (r?.ok) {
      const { blob } = await r.json();
      let peer;
      try {
        peer = asPeer(openOffer(phrase, blob));
      } catch {
        await new Promise((r2) => setTimeout(r2, 1000));
        continue;
      }
      if (peer.fingerprint === fingerprint(id.ed.pub))
        die("that pairing reply carries your own key");
      peer.label = adoptPeer(peer);
      await ensureDaemon(ROOT_DIR);
      console.log(`
Paired with "${peer.label}".

  them  ${peer.fingerprint}
  you   ${fingerprint(id.ed.pub)}

Read both to each other. If they match, nobody is in the middle.

They start at "ask": a line on your screen, and their agent may ask yours a
question. Nothing they do puts their words inside your turn.

  /crosstalk:trust`);
      return;
    }
    await new Promise((r2) => setTimeout(r2, 1000));
  }
  die("that invite expired without anyone using it");
}
async function peers() {
  if (!await ensureDaemon(ROOT_DIR))
    die("daemon is not running; see ~/.claude/crosstalk/daemon.log");
  const r = await request({ op: "peers" });
  console.log(`
you   ${r.me.label}   relay ${r.relay}`);
  for (const s of r.me.sessions)
    console.log(`      ${s.name}  ${s.cwd}  ${s.status}`);
  if (!r.peers.length) {
    console.log(`
No peers yet. Run /crosstalk:pair --host to invite someone.
`);
    return;
  }
  for (const p of r.peers) {
    const muted = p.policy.mutedUntil && p.policy.mutedUntil > Date.now();
    console.log(`
${p.online ? "\u25CF" : "\u25CB"} ${p.label}  ${p.fingerprint}  ${p.policy.delivery}${muted ? " (muted)" : ""}${p.unread ? `  ${p.unread} unread` : ""}`);
    if (!p.sessions.length)
      console.log(`      no sessions reported  (presence ${ago(p.presenceAt)})`);
    for (const s of p.sessions)
      console.log(`      ${s.name}  ${s.cwd}  ${s.status}  ${ago(s.lastSeen)}`);
  }
  console.log();
}
async function mute() {
  const peer = positional[0] && !/^\d+$/.test(positional[0]) ? positional[0] : undefined;
  const minutes = Number(positional.find((a) => /^\d+$/.test(a)) ?? 60);
  await ensureDaemon(ROOT_DIR);
  const r = await request({ op: "mute", peer, minutes });
  console.log(r.mutedUntil ? `muted ${peer ?? "all peers"} until ${new Date(r.mutedUntil).toLocaleTimeString()}` : `unmuted ${peer ?? "all peers"}`);
}
async function policy() {
  const mode = positional.find((a) => ["notify", "deliver", "quiet"].includes(a));
  const peer = positional.find((a) => a !== mode);
  const set = {};
  if (mode)
    set.delivery = mode;
  if (has("--allow-ask"))
    set.allowAsk = true;
  if (has("--no-allow-ask"))
    set.allowAsk = false;
  if (!Object.keys(set).length) {
    const p = loadPolicy();
    console.log(`
default   ${p.default.delivery}   ask ${p.default.allowAsk ? "allowed" : "off"}`);
    for (const label of Object.keys(loadPeers())) {
      const pp = policyFor(label, p);
      console.log(`${label.padEnd(10)}${pp.delivery}   ask ${pp.allowAsk ? "allowed" : "off"}`);
    }
    console.log(`
  notify    a notice appears; their words stay behind crosstalk_read  (default)
  deliver   their text lands in your session mid-turn
  quiet     held silently, surfaced when the session next goes idle

  Questions are allowed from people you paired with. Turn them off for someone
  with /crosstalk:policy <name> --no-allow-ask.
`);
    return;
  }
  await ensureDaemon(ROOT_DIR);
  const r = await request({ op: "policy", peer, set });
  console.log(JSON.stringify(r.policy, null, 2));
}
async function cost() {
  const s = daemonRunning() ? await request({ op: "usage" }) : { ...summarise() };
  if (!s.rows?.length)
    return console.log("no crosstalk messages yet");
  console.log(`
peer        sent   recvd   to Claude   ~tokens out   ~tokens in`);
  for (const r of s.rows) {
    console.log(`${r.peer.padEnd(12)}${String(r.sent).padEnd(7)}${String(r.received).padEnd(8)}${String(r.deliveredToClaude).padEnd(12)}${String(r.estTokensOut).padEnd(14)}${r.estTokensIn}`);
  }
  console.log(`
A delivered message costs the receiver a turn, like a prompt they typed.
Token figures are a rough estimate from message length, for orientation only.
`);
}
async function status() {
  const id = loadIdentity();
  if (!id)
    return console.log("crosstalk: not set up. Run /crosstalk:pair --host.");
  console.log(`identity  ${id.label}  ${fingerprint(id.ed.pub)}`);
  console.log(`relay     ${loadRelay().url}`);
  console.log(`peers     ${Object.keys(loadPeers()).join(", ") || "none"}`);
  if (!daemonRunning())
    return console.log("daemon    not running");
  const r = await request({ op: "status" });
  console.log(`daemon    running, relay ${r.relay}`);
  for (const s of r.sessions)
    console.log(`          ${s.name}  ${s.cwd}`);
}
async function doctor() {
  const rows = [];
  const id = loadIdentity();
  const socket = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  rows.push(["runtime", true, `${path8.basename(process.execPath)} ${process.version ?? ""}`.trim()]);
  rows.push(["identity", !!id, id ? `${id.label}  ${fingerprint(id.ed.pub)}` : "none, run /crosstalk:pair --host"]);
  rows.push([
    "peers",
    Object.keys(loadPeers()).length > 0,
    Object.keys(loadPeers()).join(", ") || "none paired yet"
  ]);
  rows.push(["inbox socket", !!socket && fs6.existsSync(socket), socket ?? "CLAUDE_CODE_MESSAGING_SOCKET not set"]);
  rows.push([
    "messaging token",
    !!process.env.CLAUDE_CODE_MESSAGING_TOKEN,
    process.env.CLAUDE_CODE_MESSAGING_TOKEN ? "present" : "missing, messages arrive as anonymous peers"
  ]);
  const sessionsDir = path8.join(process.env.HOME ?? "", ".claude", "sessions");
  let visible = 0;
  try {
    visible = fs6.readdirSync(sessionsDir).filter((f) => f.endsWith(".json")).length;
  } catch {}
  rows.push(["session registry", visible > 0, `${visible} entries in ${sessionsDir}`]);
  const relayUrl = loadRelay().url;
  const reach = await relayReachable(relayUrl);
  rows.push(["relay", reach, relayUrl]);
  if (relayPid()) {
    const addr = bestAddress();
    const all = allAddresses();
    rows.push([
      "relay is yours",
      true,
      `serving on all interfaces; hand out ${addr.host}${all.length > 1 ? `  (also have ${all.filter((a) => a.host !== addr.host).map((a) => a.host).join(", ")})` : ""}`
    ]);
    if (process.platform === "darwin") {
      let fw = "";
      try {
        fw = execFileSync4("/usr/libexec/ApplicationFirewall/socketfilterfw", ["--getglobalstate"], {
          encoding: "utf8"
        }).trim();
      } catch {}
      const on = /State = 1|enabled/i.test(fw);
      rows.push([
        "macOS firewall",
        !on,
        on ? "on, which can silently drop the other machine's connection. Allow incoming for bun or node, or turn it off while pairing." : "off, incoming connections are not blocked"
      ]);
    }
  }
  rows.push(["daemon", daemonRunning(), daemonRunning() ? "running" : "not running (starts on next session)"]);
  if (daemonRunning()) {
    try {
      const s = await request({ op: "status" });
      rows.push(["daemon \u2194 relay", s.relay === "connected", s.relay]);
      rows.push(["registered sessions", s.sessions.length > 0, s.sessions.map((x) => x.name).join(", ") || "none"]);
    } catch (e) {
      rows.push(["daemon \u2194 relay", false, e.message]);
    }
  }
  console.log();
  for (const [name, ok, detail] of rows) {
    console.log(`${ok === null ? "\xB7" : ok ? "\u2713" : "\u2717"}  ${name.padEnd(20)} ${detail}`);
  }
  const bad = rows.filter(([, ok]) => ok === false);
  console.log(bad.length ? `
${bad.length} thing(s) to fix above.
` : `
All good.
`);
}
async function daemon() {
  const sub = positional[0] ?? "start";
  if (sub === "stop" || sub === "restart") {
    try {
      process.kill(Number(fs6.readFileSync(P.daemonLock, "utf8")), "SIGTERM");
      console.log("daemon stopped");
    } catch {
      console.log("daemon was not running");
    }
    if (sub === "stop")
      return;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(await ensureDaemon(ROOT_DIR) ? "daemon running" : "daemon failed to start");
}
async function room() {
  await ensureDaemon(ROOT_DIR);
  const [verb, ...rest] = positional;
  if (!verb || verb === "list") {
    const r = await request({ op: "rooms" });
    const direct = r.direct ?? [];
    if (!r.rooms.length && !direct.length) {
      console.log(`
You are not in anything yet.

  /crosstalk:pair --host          pair with someone, which makes a room of two
  /crosstalk:room create beta     a room for several people
`);
      return;
    }
    console.log();
    if (direct.length) {
      for (const room2 of direct)
        console.log(`  ${room2.name.padEnd(16)}just the two of you`);
    }
    for (const room2 of r.rooms) {
      const who = room2.members.map((m) => m.label + (m.you ? " (you)" : "") + (m.state === "invited" ? " (invited)" : "") + (!m.paired && !m.you ? " \xB7not paired" : "")).join(", ");
      if (room2.pending) {
        console.log(`  #${room2.name}   INVITATION from ${room2.pending.invitedBy}`);
        console.log(`      ${who}`);
        console.log(`      accept:  /crosstalk:room accept ${room2.name}`);
      } else {
        console.log(`  #${room2.name}`.padEnd(18) + who);
      }
    }
    console.log();
    return;
  }
  const say = (r, ok) => r.ok ? console.log(ok) : die(r.error);
  switch (verb) {
    case "create": {
      const name = rest[0] ?? die("name the room: /crosstalk:room create beta");
      const r = await request({ op: "room_create", name });
      say(r, `created #${r.room}. Invite someone you are paired with:

  /crosstalk:room invite ${r.room} <peer>
`);
      return;
    }
    case "invite": {
      const [name, ...people] = rest;
      if (!name || !people.length)
        die("usage: /crosstalk:room invite beta marie jo");
      for (const p of people) {
        const r = await request({ op: "room_invite", room: name, peer: p });
        r.ok ? console.log(`invited ${r.invited} to #${r.room}`) : console.error(`${p}: ${r.error}`);
      }
      console.log(`
They each have to accept before anything from the room reaches them.`);
      return;
    }
    case "accept":
    case "decline":
    case "leave": {
      const name = rest[0] ?? die(`usage: /crosstalk:room ${verb} beta`);
      const r = await request({ op: `room_${verb}`, room: name });
      say(r, verb === "accept" ? `joined #${r.room}` : `left #${r.room}`);
      return;
    }
    case "kick":
    case "remove": {
      const [name, who] = rest;
      if (!name || !who)
        die("usage: /crosstalk:room kick beta marie");
      const r = await request({ op: "room_kick", room: name, peer: who });
      if (!r.ok)
        die(r.error);
      console.log(`removed ${r.removed} from #${name} and rekeyed to epoch ${r.rekeyedTo}`);
      if (r.unreachable?.length)
        console.log(`
Could not hand the new key to: ${r.unreachable.join(", ")}.
You are not paired with them, so someone who is has to pass it on.`);
      return;
    }
    default:
      die(`unknown: /crosstalk:room ${verb}

Try: list, create, invite, accept, decline, leave, kick`);
  }
}
async function secure() {
  const r = secureIdentity();
  if (r.moved) {
    console.log(`
Your private key is in the macOS keychain now. ${P.identity} keeps only the
public half, so a process that reads your files no longer walks away with your
identity.

Undo with:  security delete-generic-password -a crosstalk -s crosstalk-identity
(after which you would have to pair again)`);
    return;
  }
  console.log(`not moved: ${r.reason}`);
}
async function rename() {
  const [a, b] = positional;
  if (has("--me") || a === "me") {
    const to = (has("--me") ? a : b)?.trim();
    if (!to)
      die("usage: /crosstalk:rename me <newname>");
    const id = loadIdentity();
    if (!id)
      die("no identity yet");
    const was = id.label;
    id.label = to;
    saveIdentity(id);
    console.log(`you are "${to}" now, was "${was}".`);
    console.log("People you have already paired with keep the name they gave you.");
    if (daemonRunning())
      console.log("Restart the daemon to advertise it: /crosstalk:status then crosstalk daemon restart");
    return;
  }
  if (!a || !b) {
    const peers3 = loadPeers();
    console.log(`
usage: /crosstalk:rename <current> <new>
       /crosstalk:rename me <new>
`);
    console.log(`known: ${Object.keys(peers3).join(", ") || "nobody yet"}
`);
    return;
  }
  const peers2 = loadPeers();
  const peer = peers2[a];
  if (!peer)
    die(`no peer called "${a}". Known: ${Object.keys(peers2).join(", ") || "nobody"}`);
  if (peers2[b])
    die(`"${b}" is already someone else (${peers2[b].fingerprint})`);
  delete peers2[a];
  peers2[b] = { ...peer, label: b };
  savePeers(peers2);
  const pol = loadPolicy();
  if (pol.peers[a]) {
    pol.peers[b] = pol.peers[a];
    delete pol.peers[a];
    savePolicy(pol);
  }
  try {
    const uPath = path8.join(ROOT, "usage.json");
    const u = JSON.parse(fs6.readFileSync(uPath, "utf8"));
    if (u[a]) {
      u[b] = u[a];
      delete u[a];
      fs6.writeFileSync(uPath, JSON.stringify(u, null, 2), { mode: 384 });
    }
  } catch {}
  try {
    const qPath = path8.join(ROOT, "queue.json");
    const q = JSON.parse(fs6.readFileSync(qPath, "utf8"));
    let touched = 0;
    for (const msgs of Object.values(q))
      for (const m of msgs)
        if (m.from === a)
          m.from = b, touched++;
    if (touched)
      fs6.writeFileSync(qPath, JSON.stringify(q, null, 2), { mode: 384 });
  } catch {}
  console.log(`"${a}" is "${b}" now, still ${peer.fingerprint}.`);
  if (daemonRunning())
    console.log("Restart the daemon so it picks this up: crosstalk daemon restart");
}
async function trustCmd() {
  const t = load2();
  const level = positional.find((a) => isLevel(a));
  const who = positional.find((a) => a !== level);
  const room2 = flag("--in");
  if (!who && !level) {
    console.log();
    console.log(`  default${" ".repeat(12)}${t.default}`);
    const rooms = Object.entries(t.rooms);
    if (rooms.length) {
      console.log(`
  rooms`);
      for (const [n, l] of rooms)
        console.log(`    #${n.padEnd(16)}${l}`);
    }
    const people = Object.entries(t.people);
    if (people.length) {
      console.log(`
  pinned people`);
      for (const [n, l] of people)
        console.log(`    ${n.padEnd(17)}${l}`);
    }
    console.log(`
  levels, each including the ones before it
`);
    for (const l of LEVELS)
      console.log(`    ${l.padEnd(10)}${DESCRIPTION[l]}`);
    console.log(`
  /crosstalk:trust marie ask          pin a person
  /crosstalk:trust incident deliver   set a room, for everyone in it
  /crosstalk:trust marie mute --in ideas
`);
    return;
  }
  if (!level)
    die(`give a level: ${LEVELS.join(", ")}`);
  if (!who) {
    t.default = level;
    save(t);
    return console.log(`anyone you have paired with, by default: ${level}`);
  }
  const isPerson = !!loadPeers()[who];
  if (room2) {
    t.people[who] = level;
    t.rooms[room2] = t.rooms[room2] ?? ROOM_DEFAULT;
    save(t);
    return console.log(`${who} is "${level}" (pinned, so it applies in #${room2} too)`);
  }
  if (isPerson) {
    t.people[who] = level;
    save(t);
    return console.log(`${who}: ${level}`);
  }
  t.rooms[who.replace(/^#/, "")] = level;
  save(t);
  console.log(`#${who.replace(/^#/, "")}: ${level} for everyone in it`);
}
var commands = {
  pair,
  rename,
  trust: trustCmd,
  room,
  secure,
  peers,
  mute,
  policy,
  cost,
  status,
  doctor,
  daemon,
  relay
};
await (commands[cmd] ?? (async () => die(`unknown command "${cmd}"`)))();
