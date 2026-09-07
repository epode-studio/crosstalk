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
  usage: path.join(ROOT, "usage.json"),
  daemonSock: path.join(ROOT, "daemon.sock"),
  daemonLock: path.join(ROOT, "daemon.lock"),
  log: path.join(ROOT, "daemon.log")
};
var DEFAULT_POLICY = {
  default: { delivery: "notify", allowAsk: false },
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
function policyFor(label, policy = loadPolicy()) {
  return { ...policy.default, ...policy.peers[label] ?? {} };
}
var loadRelay = () => readJson(P.relay, { url: process.env.CROSSTALK_RELAY ?? "ws://127.0.0.1:8787" });
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
  edPub: o.edPub,
  xPub: o.xPub,
  fingerprint: fingerprint(o.edPub),
  pairedAt: Date.now()
});

// src/crypto.ts
var normalisePhrase2 = (p) => p.trim().toLowerCase().replace(/\s+/g, "-").replace(/-+/g, "-");

// src/invite.ts
var DEFAULT_PORT = 8787;
function formatInvite(phrase, relayUrl, omitRelay) {
  if (omitRelay)
    return phrase;
  const u = new URL(relayUrl.replace(/^ws/, "http"));
  const port = u.port && Number(u.port) !== DEFAULT_PORT ? `:${u.port}` : "";
  return `${phrase} @ ${u.hostname}${port}`;
}
function parseInvite(input) {
  const raw = input.trim().replace(/^["']|["']$/g, "");
  const [left, right] = raw.split("@").map((s) => s?.trim());
  const phrase = normalisePhrase2(left ?? "");
  if (!phrase || phrase.split("-").length < 3)
    throw new Error(`"${input}" does not look like a pairing phrase (expected four words)`);
  if (!right)
    return { phrase };
  const [host, port] = right.split(":");
  return { phrase, relay: `ws://${host}:${port || DEFAULT_PORT}` };
}

// src/net.ts
import os2 from "node:os";
import { execFileSync as execFileSync2 } from "node:child_process";
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

// src/usage.ts
import fs3 from "node:fs";
import path4 from "node:path";
var FILE = path4.join(ROOT2, "usage.json");
function load() {
  try {
    return JSON.parse(fs3.readFileSync(FILE, "utf8"));
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

// src/paths.ts
import path5 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var dirOf2 = (metaUrl) => path5.dirname(fileURLToPath2(metaUrl));
var rootFrom2 = (metaUrl) => path5.join(dirOf2(metaUrl), "..");
var shim2 = (root) => path5.join(root, "bin", "crosstalk");

// src/cli.ts
import fs4 from "fs";
import path6 from "path";
import { spawn as spawn2, execFileSync as execFileSync3 } from "child_process";
var argv = process.argv.slice(2);
var cmd = argv[0] ?? "status";
var VALUE_FLAGS = new Set(["--label", "--phrase", "--relay", "--port", "--address"]);
var DEFAULT_RELAY = process.env.CROSSTALK_DEFAULT_RELAY ?? "";
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
var RELAY_PID = path6.join(ROOT, "relay.pid");
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
  const label = flag("--label") ?? (() => {
    try {
      return execFileSync3("git", ["config", "user.name"], { encoding: "utf8" }).trim().split(" ")[0].toLowerCase();
    } catch {
      return process.env.USER ?? "me";
    }
  })();
  const id = newIdentity(label);
  saveIdentity(id);
  console.log(`created identity "${label}"   ${fingerprint(id.ed.pub)}`);
  return id;
}
var relayPid = () => {
  try {
    const pid = Number(fs4.readFileSync(RELAY_PID, "utf8"));
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
  const out = fs4.openSync(path6.join(ROOT, "relay.log"), "a");
  const child = spawn2(shim2(ROOT_DIR), ["relay", "--host", "0.0.0.0", "--port", String(port)], {
    detached: true,
    stdio: ["ignore", out, out]
  });
  child.unref();
  fs4.mkdirSync(ROOT, { recursive: true, mode: 448 });
  fs4.writeFileSync(RELAY_PID, String(child.pid), { mode: 384 });
  const url = `ws://${addr.host}:${port}`;
  saveRelay(url);
  for (let i = 0;i < 40; i++) {
    if (await relayReachable(url, 500))
      break;
    await new Promise((r) => setTimeout(r, 100));
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
    fs4.rmSync(RELAY_PID, { force: true });
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
  edPub: id.ed.pub,
  xPub: id.x.pub
});
function adoptPeer(peer) {
  const peers = loadPeers();
  const existing = peers[peer.label];
  if (existing && existing.fingerprint !== peer.fingerprint) {
    die(`you are already paired with someone called "${peer.label}".

  existing  ${existing.fingerprint}
  new       ${peer.fingerprint}

Refusing to replace them, a new peer must not inherit an existing peer's policy.
Ask them to pair again under a different name (--label), or remove the old peer
from ~/.claude/crosstalk/peers.json if you know it is stale.`);
  }
  peers[peer.label] = peer;
  savePeers(peers);
}
async function pair() {
  if (has("--relay"))
    saveRelay(flag("--relay"));
  const id = identityOrCreate();
  const joining = positional.join(" ").trim();
  if (joining) {
    const inv = parseInvite(joining);
    if (inv.relay)
      saveRelay(inv.relay);
    const code2 = codeForPhrase(inv.phrase);
    if (!await relayReachable())
      die(`cannot reach the relay at ${httpBase()}.

If they hosted it themselves, their machine has to be awake and reachable from here, same network, or both on the same tailnet.`);
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
    adoptPeer(peer);
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

Check both against what they see. Their messages arrive as "notify": you get a
notice, and their words stay behind the crosstalk_read tool until your Claude
fetches them. Change that per peer with /crosstalk:policy.`);
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
  const sameRelayAsDefault = url === DEFAULT_RELAY;
  const invite = formatInvite(phrase, url, sameRelayAsDefault);
  const addr = bestAddress();
  console.log(`
Tell them these words:

    ${invite}

They run  /crosstalk:pair ${invite}

Say it out loud, or send it somewhere you already trust. Not through the relay.
Whoever has these words can pair with you until they expire.

  you       ${id.label}  ${fingerprint(id.ed.pub)}
  relay     ${url}${sameRelayAsDefault ? "" : `  (${addr.kind}: ${addr.note})`}
  expires   15 minutes

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
      adoptPeer(peer);
      await ensureDaemon(ROOT_DIR);
      console.log(`
Paired with "${peer.label}".

  them  ${peer.fingerprint}
  you   ${fingerprint(id.ed.pub)}

Read both aloud and check they match. Their messages arrive as "notify".`);
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
  rows.push(["runtime", true, `${path6.basename(process.execPath)} ${process.version ?? ""}`.trim()]);
  rows.push(["identity", !!id, id ? `${id.label}  ${fingerprint(id.ed.pub)}` : "none, run /crosstalk:pair --host"]);
  rows.push([
    "peers",
    Object.keys(loadPeers()).length > 0,
    Object.keys(loadPeers()).join(", ") || "none paired yet"
  ]);
  rows.push(["inbox socket", !!socket && fs4.existsSync(socket), socket ?? "CLAUDE_CODE_MESSAGING_SOCKET not set"]);
  rows.push([
    "messaging token",
    !!process.env.CLAUDE_CODE_MESSAGING_TOKEN,
    process.env.CLAUDE_CODE_MESSAGING_TOKEN ? "present" : "missing, messages arrive as anonymous peers"
  ]);
  const sessionsDir = path6.join(process.env.HOME ?? "", ".claude", "sessions");
  let visible = 0;
  try {
    visible = fs4.readdirSync(sessionsDir).filter((f) => f.endsWith(".json")).length;
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
        fw = execFileSync3("/usr/libexec/ApplicationFirewall/socketfilterfw", ["--getglobalstate"], {
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
      process.kill(Number(fs4.readFileSync(P.daemonLock, "utf8")), "SIGTERM");
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
    if (!r.rooms.length) {
      console.log(`
No rooms. Make one:

  /crosstalk:room create beta
  /crosstalk:room invite beta marie
`);
      return;
    }
    console.log();
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
var commands = {
  pair,
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
