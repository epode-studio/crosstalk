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
var identityUnreadable = () => {
  if (!fs.existsSync(P.identity))
    return false;
  try {
    return !JSON.parse(fs.readFileSync(P.identity, "utf8"));
  } catch {
    return true;
  }
};
var saveIdentity = (id) => {
  if (identityUnreadable())
    throw new Error(`${P.identity} exists but will not parse, so crosstalk will not write over it. ` + `Move it somewhere safe first: it holds the only copy of your private key.`);
  writeJson(P.identity, id);
};
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
var newPhrase = (words = 5) => Array.from({ length: words }, () => WORDS[crypto.randomInt(WORDS.length)]).join("-");
var SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
var asPeer = (o) => ({
  label: o.label,
  machine: o.machine,
  isMachine: o.isMachine,
  edPub: o.edPub,
  xPub: o.xPub,
  fingerprint: fingerprint(o.edPub),
  joinedAt: Date.now()
});

// node_modules/@noble/hashes/_u64.js
var U32_MASK64 = /* @__PURE__ */ (() => BigInt(2 ** 32 - 1))();
var _32n = /* @__PURE__ */ BigInt(32);
function fromBig(n, le = false) {
  if (le)
    return { h: Number(n & U32_MASK64), l: Number(n >> _32n & U32_MASK64) };
  return { h: Number(n >> _32n & U32_MASK64) | 0, l: Number(n & U32_MASK64) | 0 };
}
function split(lst, le = false) {
  const len = lst.length;
  let Ah = new Uint32Array(len);
  let Al = new Uint32Array(len);
  for (let i = 0;i < len; i++) {
    const { h, l } = fromBig(lst[i], le);
    [Ah[i], Al[i]] = [h, l];
  }
  return [Ah, Al];
}
var fromNumH = (n) => n / 2 ** 32 | 0;
var fromNumL = (n) => n >>> 0;
function setU64FromNum(view, byteOffset, n, isLE) {
  const h = fromNumH(n);
  const l = fromNumL(n);
  view.setUint32(byteOffset, isLE ? l : h, isLE);
  view.setUint32(byteOffset + 4, isLE ? h : l, isLE);
}
var shrSH = (h, _l, s) => h >>> s;
var shrSL = (h, l, s) => h << 32 - s | l >>> s;
var rotrSH = (h, l, s) => h >>> s | l << 32 - s;
var rotrSL = (h, l, s) => h << 32 - s | l >>> s;
var rotrBH = (h, l, s) => h << 64 - s | l >>> s - 32;
var rotrBL = (h, l, s) => h >>> s - 32 | l << 64 - s;
function add(Ah, Al, Bh, Bl) {
  const l = (Al >>> 0) + (Bl >>> 0);
  return { h: Ah + Bh + (l / 2 ** 32 | 0) | 0, l: l | 0 };
}
var add3L = (Al, Bl, Cl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0);
var add3H = (low, Ah, Bh, Ch) => Ah + Bh + Ch + (low / 2 ** 32 | 0) | 0;
var add4L = (Al, Bl, Cl, Dl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0);
var add4H = (low, Ah, Bh, Ch, Dh) => Ah + Bh + Ch + Dh + (low / 2 ** 32 | 0) | 0;
var add5L = (Al, Bl, Cl, Dl, El) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0) + (El >>> 0);
var add5H = (low, Ah, Bh, Ch, Dh, Eh) => Ah + Bh + Ch + Dh + Eh + (low / 2 ** 32 | 0) | 0;

// node_modules/@noble/hashes/utils.js
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array" && "BYTES_PER_ELEMENT" in a && a.BYTES_PER_ELEMENT === 1;
}
var atitle = (title) => title ? `"${title}" ` : "";
function anumber(n, title = "") {
  if (typeof n !== "number")
    throw new TypeError(atitle(title) + "expected number, got " + typeof n);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new RangeError(atitle(title) + "expected integer >= 0, got " + n);
  return n;
}
function abytes(value, length, title = "") {
  if (isBytes(value) && (length === undefined || value.length === length))
    return value;
  if (length !== undefined)
    anumber(length, "length");
  const bytes = isBytes(value);
  const ofLen = length !== undefined ? ` of length ${length}` : "";
  const got = bytes ? `length=${value.length}` : `type=${typeof value}`;
  const message = atitle(title) + "expected Uint8Array" + ofLen + ", got " + got;
  if (!bytes)
    throw new TypeError(message);
  throw new RangeError(message);
}
var aobject = (value, label) => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError((label === "object" ? "" : `"${label}" `) + "expected object, got type=" + typeof value);
};
var aopts = (value, label) => {
  aobject(value, label);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null)
    throw new TypeError(`"${label}" expected plain object`);
  if (Object.hasOwn(value, "__proto__"))
    throw new TypeError(`"${label}.__proto__" is not allowed`);
};
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("hash was destroyed");
  if (checkFinished && instance.finished)
    throw new Error("digest() was already called");
}
function aoutput(out, instance) {
  abytes(out, undefined, "output");
  const min = instance.outputLen;
  if (!(out.length >= min)) {
    throw new RangeError('"output" expected length >= ' + min);
  }
}
function clean(...arrays) {
  for (let i = 0;i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
var hasHexBuiltin = /* @__PURE__ */ (() => typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function")();
var hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
function bytesToHex(bytes) {
  abytes(bytes);
  if (hasHexBuiltin)
    return bytes.toHex();
  let hex = "";
  for (let i = 0;i < bytes.length; i++) {
    hex += hexes[bytes[i]];
  }
  return hex;
}
function asciiToBase16(ch) {
  return ch >= 48 && ch <= 57 ? ch - 48 : ch >= 65 && ch <= 70 ? ch - (65 - 10) : ch >= 97 && ch <= 102 ? ch - (97 - 10) : undefined;
}
function hexToBytes(hex) {
  if (typeof hex !== "string")
    throw new TypeError("hex string expected, got " + typeof hex);
  if (hasHexBuiltin) {
    try {
      return Uint8Array.fromHex(hex);
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new RangeError(error.message);
      throw error;
    }
  }
  const hl = hex.length;
  const al = hl / 2;
  if (hl % 2)
    throw new RangeError("hex string expected, got unpadded hex of length " + hl);
  const array = new Uint8Array(al);
  for (let ai = 0, hi = 0;ai < al; ai++, hi += 2) {
    const n1 = asciiToBase16(hex.charCodeAt(hi));
    const n2 = asciiToBase16(hex.charCodeAt(hi + 1));
    if (n1 === undefined || n2 === undefined) {
      const char = hex[hi] + hex[hi + 1];
      throw new RangeError('hex string expected, got non-hex character "' + char + '" at index ' + hi);
    }
    array[ai] = n1 * 16 + n2;
  }
  return array;
}
function concatBytes(...arrays) {
  let sum = 0;
  for (let i = 0;i < arrays.length; i++) {
    const a = arrays[i];
    abytes(a);
    sum += a.length;
  }
  const res = new Uint8Array(sum);
  for (let i = 0, pad = 0;i < arrays.length; i++) {
    const a = arrays[i];
    res.set(a, pad);
    pad += a.length;
  }
  return res;
}
function checkOpts(defaults, opts, title = "opts") {
  aopts(defaults, "defaults");
  if (opts !== undefined)
    aopts(opts, title);
  const merged = Object.assign(Object.create(null), defaults, opts);
  return merged;
}
function createHasher(hashCons, info = {}) {
  if (typeof hashCons !== "function")
    throw new TypeError('"hashCons" expected function, got type=' + typeof hashCons);
  info = checkOpts({}, info, "info");
  const hashC = (msg, opts) => hashCons(opts).update(msg).digest();
  const tmp = hashCons(undefined);
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.canXOF = tmp.canXOF;
  hashC.create = (opts) => hashCons(opts);
  Object.assign(hashC, info);
  return Object.freeze(hashC);
}
function randomBytes(bytesLength = 32) {
  anumber(bytesLength, "bytesLength");
  const cr = typeof globalThis === "object" ? globalThis.crypto : null;
  if (typeof cr?.getRandomValues !== "function")
    throw new Error("crypto.getRandomValues must be defined");
  if (bytesLength > 65536)
    throw new RangeError(`"bytesLength" expected <= 65536, got ${bytesLength}`);
  return cr.getRandomValues(new Uint8Array(bytesLength));
}
var oidNist = (suffix) => ({
  oid: Uint8Array.from([6, 9, 96, 134, 72, 1, 101, 3, 4, 2, suffix])
});

// node_modules/@noble/hashes/_md.js
class HashMD {
  blockLen;
  outputLen;
  canXOF = false;
  padOffset;
  isLE;
  buffer;
  view;
  finished = false;
  length = 0;
  pos = 0;
  destroyed = false;
  constructor(blockLen, outputLen, padOffset, isLE) {
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.padOffset = padOffset;
    this.isLE = isLE;
    this.buffer = new Uint8Array(blockLen);
    this.view = createView(this.buffer);
  }
  update(data) {
    aexists(this);
    abytes(data);
    const { view, buffer, blockLen } = this;
    const len = data.length;
    let processed = false;
    for (let pos = 0;pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        const dataView = createView(data);
        for (;blockLen <= len - pos; pos += blockLen)
          this.process(dataView, pos);
        processed = true;
        continue;
      }
      buffer.set(pos === 0 && take === len ? data : data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(view, 0);
        this.pos = 0;
        processed = true;
      }
    }
    this.length += data.length;
    if (processed)
      this.roundClean();
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const { buffer, view, blockLen, isLE } = this;
    let { pos } = this;
    buffer[pos++] = 128;
    buffer.fill(0, pos);
    if (this.padOffset > blockLen - pos) {
      this.process(view, 0);
      buffer.fill(0);
    }
    setU64FromNum(view, blockLen - 8, this.length * 8, isLE);
    this.process(view, 0);
    this.roundClean();
    const oview = out === buffer ? view : createView(out);
    const len = this.outputLen;
    const outLen = len / 4;
    const state = this.get();
    if (len % 4 || outLen > state.length)
      throw new Error("invalid outputLen");
    for (let i = 0;i < outLen; i++)
      oview.setUint32(4 * i, state[i], isLE);
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
  _cloneIntoMeta(to) {
    const { buffer, length, finished, destroyed, pos } = this;
    to.destroyed = destroyed;
    to.finished = finished;
    to.length = length;
    to.pos = pos;
    if (pos)
      to.buffer.set(buffer);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
}
var SHA512_IV = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  4089235720,
  3144134277,
  2227873595,
  1013904242,
  4271175723,
  2773480762,
  1595750129,
  1359893119,
  2917565137,
  2600822924,
  725511199,
  528734635,
  4215389547,
  1541459225,
  327033209
]);

// node_modules/@noble/hashes/sha2.js
var K512 = /* @__PURE__ */ (() => split([
  "0x428a2f98d728ae22",
  "0x7137449123ef65cd",
  "0xb5c0fbcfec4d3b2f",
  "0xe9b5dba58189dbbc",
  "0x3956c25bf348b538",
  "0x59f111f1b605d019",
  "0x923f82a4af194f9b",
  "0xab1c5ed5da6d8118",
  "0xd807aa98a3030242",
  "0x12835b0145706fbe",
  "0x243185be4ee4b28c",
  "0x550c7dc3d5ffb4e2",
  "0x72be5d74f27b896f",
  "0x80deb1fe3b1696b1",
  "0x9bdc06a725c71235",
  "0xc19bf174cf692694",
  "0xe49b69c19ef14ad2",
  "0xefbe4786384f25e3",
  "0x0fc19dc68b8cd5b5",
  "0x240ca1cc77ac9c65",
  "0x2de92c6f592b0275",
  "0x4a7484aa6ea6e483",
  "0x5cb0a9dcbd41fbd4",
  "0x76f988da831153b5",
  "0x983e5152ee66dfab",
  "0xa831c66d2db43210",
  "0xb00327c898fb213f",
  "0xbf597fc7beef0ee4",
  "0xc6e00bf33da88fc2",
  "0xd5a79147930aa725",
  "0x06ca6351e003826f",
  "0x142929670a0e6e70",
  "0x27b70a8546d22ffc",
  "0x2e1b21385c26c926",
  "0x4d2c6dfc5ac42aed",
  "0x53380d139d95b3df",
  "0x650a73548baf63de",
  "0x766a0abb3c77b2a8",
  "0x81c2c92e47edaee6",
  "0x92722c851482353b",
  "0xa2bfe8a14cf10364",
  "0xa81a664bbc423001",
  "0xc24b8b70d0f89791",
  "0xc76c51a30654be30",
  "0xd192e819d6ef5218",
  "0xd69906245565a910",
  "0xf40e35855771202a",
  "0x106aa07032bbd1b8",
  "0x19a4c116b8d2d0c8",
  "0x1e376c085141ab53",
  "0x2748774cdf8eeb99",
  "0x34b0bcb5e19b48a8",
  "0x391c0cb3c5c95a63",
  "0x4ed8aa4ae3418acb",
  "0x5b9cca4f7763e373",
  "0x682e6ff3d6b2b8a3",
  "0x748f82ee5defb2fc",
  "0x78a5636f43172f60",
  "0x84c87814a1f0ab72",
  "0x8cc702081a6439ec",
  "0x90befffa23631e28",
  "0xa4506cebde82bde9",
  "0xbef9a3f7b2c67915",
  "0xc67178f2e372532b",
  "0xca273eceea26619c",
  "0xd186b8c721c0c207",
  "0xeada7dd6cde0eb1e",
  "0xf57d4f7fee6ed178",
  "0x06f067aa72176fba",
  "0x0a637dc5a2c898a6",
  "0x113f9804bef90dae",
  "0x1b710b35131c471b",
  "0x28db77f523047d84",
  "0x32caab7b40c72493",
  "0x3c9ebe0a15c9bebc",
  "0x431d67c49c100d4c",
  "0x4cc5d4becb3e42b6",
  "0x597f299cfc657e2a",
  "0x5fcb6fab3ad6faec",
  "0x6c44198c4a475817"
].map((n) => BigInt(n))))();
var SHA512_Kh = /* @__PURE__ */ (() => K512[0])();
var SHA512_Kl = /* @__PURE__ */ (() => K512[1])();
var SHA512_W_H = /* @__PURE__ */ new Uint32Array(80);
var SHA512_W_L = /* @__PURE__ */ new Uint32Array(80);

class SHA2_64B extends HashMD {
  Ah = 0;
  Al = 0;
  Bh = 0;
  Bl = 0;
  Ch = 0;
  Cl = 0;
  Dh = 0;
  Dl = 0;
  Eh = 0;
  El = 0;
  Fh = 0;
  Fl = 0;
  Gh = 0;
  Gl = 0;
  Hh = 0;
  Hl = 0;
  constructor(outputLen, IV) {
    super(128, outputLen, 16, false);
    this.Ah = IV[0] | 0;
    this.Al = IV[1] | 0;
    this.Bh = IV[2] | 0;
    this.Bl = IV[3] | 0;
    this.Ch = IV[4] | 0;
    this.Cl = IV[5] | 0;
    this.Dh = IV[6] | 0;
    this.Dl = IV[7] | 0;
    this.Eh = IV[8] | 0;
    this.El = IV[9] | 0;
    this.Fh = IV[10] | 0;
    this.Fl = IV[11] | 0;
    this.Gh = IV[12] | 0;
    this.Gl = IV[13] | 0;
    this.Hh = IV[14] | 0;
    this.Hl = IV[15] | 0;
  }
  get() {
    const { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
    return [Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl];
  }
  set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl) {
    this.Ah = Ah | 0;
    this.Al = Al | 0;
    this.Bh = Bh | 0;
    this.Bl = Bl | 0;
    this.Ch = Ch | 0;
    this.Cl = Cl | 0;
    this.Dh = Dh | 0;
    this.Dl = Dl | 0;
    this.Eh = Eh | 0;
    this.El = El | 0;
    this.Fh = Fh | 0;
    this.Fl = Fl | 0;
    this.Gh = Gh | 0;
    this.Gl = Gl | 0;
    this.Hh = Hh | 0;
    this.Hl = Hl | 0;
  }
  _cloneInto(to) {
    (to ||= new this.constructor).set(...this.get());
    return this._cloneIntoMeta(to);
  }
  process(view, offset) {
    for (let i = 0;i < 16; i++, offset += 4) {
      SHA512_W_H[i] = view.getUint32(offset);
      SHA512_W_L[i] = view.getUint32(offset += 4);
    }
    for (let i = 16;i < 80; i++) {
      const W15h = SHA512_W_H[i - 15] | 0;
      const W15l = SHA512_W_L[i - 15] | 0;
      const s0h = rotrSH(W15h, W15l, 1) ^ rotrSH(W15h, W15l, 8) ^ shrSH(W15h, W15l, 7);
      const s0l = rotrSL(W15h, W15l, 1) ^ rotrSL(W15h, W15l, 8) ^ shrSL(W15h, W15l, 7);
      const W2h = SHA512_W_H[i - 2] | 0;
      const W2l = SHA512_W_L[i - 2] | 0;
      const s1h = rotrSH(W2h, W2l, 19) ^ rotrBH(W2h, W2l, 61) ^ shrSH(W2h, W2l, 6);
      const s1l = rotrSL(W2h, W2l, 19) ^ rotrBL(W2h, W2l, 61) ^ shrSL(W2h, W2l, 6);
      const SUMl = add4L(s0l, s1l, SHA512_W_L[i - 7], SHA512_W_L[i - 16]);
      const SUMh = add4H(SUMl, s0h, s1h, SHA512_W_H[i - 7], SHA512_W_H[i - 16]);
      SHA512_W_H[i] = SUMh | 0;
      SHA512_W_L[i] = SUMl | 0;
    }
    let { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
    for (let i = 0;i < 80; i++) {
      const sigma1h = rotrSH(Eh, El, 14) ^ rotrSH(Eh, El, 18) ^ rotrBH(Eh, El, 41);
      const sigma1l = rotrSL(Eh, El, 14) ^ rotrSL(Eh, El, 18) ^ rotrBL(Eh, El, 41);
      const CHIh = Eh & Fh ^ ~Eh & Gh;
      const CHIl = El & Fl ^ ~El & Gl;
      const T1ll = add5L(Hl, sigma1l, CHIl, SHA512_Kl[i], SHA512_W_L[i]);
      const T1h = add5H(T1ll, Hh, sigma1h, CHIh, SHA512_Kh[i], SHA512_W_H[i]);
      const T1l = T1ll | 0;
      const sigma0h = rotrSH(Ah, Al, 28) ^ rotrBH(Ah, Al, 34) ^ rotrBH(Ah, Al, 39);
      const sigma0l = rotrSL(Ah, Al, 28) ^ rotrBL(Ah, Al, 34) ^ rotrBL(Ah, Al, 39);
      const MAJh = Ah & Bh ^ Ah & Ch ^ Bh & Ch;
      const MAJl = Al & Bl ^ Al & Cl ^ Bl & Cl;
      Hh = Gh | 0;
      Hl = Gl | 0;
      Gh = Fh | 0;
      Gl = Fl | 0;
      Fh = Eh | 0;
      Fl = El | 0;
      ({ h: Eh, l: El } = add(Dh | 0, Dl | 0, T1h | 0, T1l | 0));
      Dh = Ch | 0;
      Dl = Cl | 0;
      Ch = Bh | 0;
      Cl = Bl | 0;
      Bh = Ah | 0;
      Bl = Al | 0;
      const All = add3L(T1l, sigma0l, MAJl);
      Ah = add3H(All, T1h, sigma0h, MAJh);
      Al = All | 0;
    }
    ({ h: Ah, l: Al } = add(this.Ah | 0, this.Al | 0, Ah | 0, Al | 0));
    ({ h: Bh, l: Bl } = add(this.Bh | 0, this.Bl | 0, Bh | 0, Bl | 0));
    ({ h: Ch, l: Cl } = add(this.Ch | 0, this.Cl | 0, Ch | 0, Cl | 0));
    ({ h: Dh, l: Dl } = add(this.Dh | 0, this.Dl | 0, Dh | 0, Dl | 0));
    ({ h: Eh, l: El } = add(this.Eh | 0, this.El | 0, Eh | 0, El | 0));
    ({ h: Fh, l: Fl } = add(this.Fh | 0, this.Fl | 0, Fh | 0, Fl | 0));
    ({ h: Gh, l: Gl } = add(this.Gh | 0, this.Gl | 0, Gh | 0, Gl | 0));
    ({ h: Hh, l: Hl } = add(this.Hh | 0, this.Hl | 0, Hh | 0, Hl | 0));
    this.set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl);
  }
  roundClean() {
    clean(SHA512_W_H, SHA512_W_L);
  }
  destroy() {
    this.destroyed = true;
    clean(this.buffer);
    this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  }
}

class _SHA512 extends SHA2_64B {
  constructor() {
    super(64, SHA512_IV);
  }
}
var sha512 = /* @__PURE__ */ createHasher(() => new _SHA512, /* @__PURE__ */ oidNist(3));

// node_modules/@noble/curves/utils.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
function aarray(item, title, inner = () => {}) {
  if (!Array.isArray(item))
    throw new TypeError(`"${title}" expected array, got type=${typeof item}`);
  for (let i = 0;i < item.length; i++)
    inner(item[i], `${title}[${i}]`);
  return item;
}
var abytes2 = (value, length, title) => abytes(value, length, title);
var anumber2 = anumber;
function aobject2(value, title = "object") {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(title === "object" ? "expected valid options object" : `"${title}" expected object, got type=${typeof value}`);
  return value;
}
function afunction(value, title) {
  if (typeof value !== "function")
    throw new TypeError(`"${title}" is invalid: expected function, got ${typeof value}`);
  return value;
}
var bytesToHex2 = bytesToHex;
var concatBytes2 = (...arrays) => concatBytes(...arrays);
var hexToBytes2 = (hex) => hexToBytes(hex);
var isBytes2 = isBytes;
var randomBytes2 = (bytesLength) => randomBytes(bytesLength);
var _0n = /* @__PURE__ */ BigInt(0);
var _1n = /* @__PURE__ */ BigInt(1);
var atitle2 = (title) => title ? `"${title}" ` : "";
function abool(value, title = "") {
  if (typeof value !== "boolean")
    throw new TypeError(atitle2(title) + "expected boolean, got type=" + typeof value);
  return value;
}
function abignumber(n) {
  if (typeof n === "bigint") {
    if (!isPosBig(n))
      throw new RangeError("positive bigint expected, got " + n);
  } else
    anumber2(n);
  return n;
}
function asafenumber(value, title = "") {
  if (typeof value !== "number") {
    const prefix = title && `"${title}" `;
    throw new TypeError(prefix + "expected number, got type=" + typeof value);
  }
  if (!Number.isSafeInteger(value)) {
    const prefix = title && `"${title}" `;
    throw new RangeError(prefix + "expected safe integer, got " + value);
  }
}
function hexToNumber(hex) {
  if (typeof hex !== "string")
    throw new TypeError("hex string expected, got " + typeof hex);
  return hex === "" ? _0n : BigInt("0x" + hex);
}
function bytesToNumberBE(bytes) {
  return hexToNumber(bytesToHex(bytes));
}
function bytesToNumberLE(bytes) {
  return hexToNumber(bytesToHex(copyBytes(abytes(bytes)).reverse()));
}
function numberToBytesBE(n, len) {
  anumber(len);
  if (len === 0)
    throw new Error("zero output length is invalid");
  n = abignumber(n);
  const expectedLen = len * 2;
  const hex = n.toString(16);
  if (hex.length > expectedLen)
    throw new RangeError("number is too large");
  return hexToBytes(hex.padStart(expectedLen, "0"));
}
function numberToBytesLE(n, len) {
  return numberToBytesBE(n, len).reverse();
}
function equalBytes(a, b) {
  a = abytes2(a);
  b = abytes2(b);
  if (a.length !== b.length)
    return false;
  let diff = 0;
  for (let i = 0;i < a.length; i++)
    diff |= a[i] ^ b[i];
  return diff === 0;
}
function copyBytes(bytes) {
  return Uint8Array.from(abytes2(bytes));
}
function asciiToBytes(ascii) {
  if (typeof ascii !== "string")
    throw new TypeError("ascii string expected, got " + typeof ascii);
  return Uint8Array.from(ascii, (c, i) => {
    const charCode = c.charCodeAt(0);
    if (c.length !== 1 || charCode > 127) {
      throw new RangeError(`string contains non-ASCII character "${ascii[i]}" with code ${charCode} at position ${i}`);
    }
    return charCode;
  });
}
function isPosBig(n) {
  return typeof n === "bigint" && _0n <= n;
}
function inRange(n, min, max) {
  return isPosBig(n) && isPosBig(min) && isPosBig(max) && min <= n && n < max;
}
function aInRange(title, n, min, max) {
  if (!inRange(n, min, max))
    throw new RangeError("expected valid " + title + ": " + min + " <= n < " + max + ", got " + n);
}
function bitLen(n) {
  if (n < _0n)
    throw new Error("expected non-negative bigint, got " + n);
  return n === _0n ? 0 : n.toString(2).length;
}
var bitMask = (n) => {
  asafenumber(n, "n");
  return (_1n << BigInt(n)) - _1n;
};
function validateObject(object, fields = {}, optFields = {}, title = "object") {
  aobject2(object, title);
  aobject2(fields, "fields");
  aobject2(optFields, "optFields");
  function checkField(fieldName, expectedType, isOpt) {
    const label = title === "object" ? `param "${String(fieldName)}"` : `"${title}.${String(fieldName)}"`;
    const val = object[fieldName];
    if (!Object.hasOwn(object, fieldName) && (isOpt ? val !== undefined : expectedType !== "function")) {
      throw new TypeError(`${label} is invalid: expected own property`);
    }
    if (isOpt && val === undefined)
      return;
    const current = typeof val;
    if (current !== expectedType || val === null)
      throw new TypeError(`${label} is invalid: expected ${expectedType}, got ${current}`);
  }
  const iter = (f, isOpt) => Object.entries(f).forEach(([k, v]) => checkField(k, v, isOpt));
  iter(fields, false);
  iter(optFields, true);
}
var notImplemented = () => {
  throw new Error("not implemented");
};

// node_modules/@noble/curves/abstract/modular.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
var _0n2 = /* @__PURE__ */ BigInt(0);
var _1n2 = /* @__PURE__ */ BigInt(1);
var _2n = /* @__PURE__ */ BigInt(2);
var _3n = /* @__PURE__ */ BigInt(3);
var _4n = /* @__PURE__ */ BigInt(4);
var _5n = /* @__PURE__ */ BigInt(5);
var _7n = /* @__PURE__ */ BigInt(7);
var _8n = /* @__PURE__ */ BigInt(8);
var _9n = /* @__PURE__ */ BigInt(9);
var _15n = /* @__PURE__ */ BigInt(15);
var _16n = /* @__PURE__ */ BigInt(16);
var POW_WINDOWED_MIN = /* @__PURE__ */ BigInt("0x10000000000000000");
function mod(a, b) {
  if (b <= _0n2)
    throw new Error("mod: expected positive modulus, got " + b);
  const result = a % b;
  return result >= _0n2 ? result : b + result;
}
function pow(num, power, modulo) {
  if (modulo <= _1n2)
    throw new Error("pow: expected modulus > 1, got " + modulo);
  if (typeof power !== "bigint")
    throw new TypeError("invalid exponent: expected bigint, got " + typeof power);
  if (power < _0n2)
    throw new Error("invalid exponent, negatives unsupported");
  if (power === _0n2)
    return _1n2;
  if (power === _1n2)
    return num;
  let d = num % modulo;
  if (d < _0n2)
    d += modulo;
  if (power < POW_WINDOWED_MIN) {
    let p = _1n2;
    while (power > _0n2) {
      if (power & _1n2)
        p = p * d % modulo;
      d = d * d % modulo;
      power >>= _1n2;
    }
    return p;
  }
  const digits = [];
  while (power > _0n2) {
    digits.push(Number(power & _15n));
    power >>= _4n;
  }
  const table = new Array(16);
  table[0] = _1n2;
  table[1] = d;
  for (let i = 2;i < 16; i++)
    table[i] = table[i - 1] * d % modulo;
  let p = table[digits[digits.length - 1]];
  for (let w = digits.length - 2;w >= 0; w--) {
    p = p * p % modulo;
    p = p * p % modulo;
    p = p * p % modulo;
    p = p * p % modulo;
    const digit = digits[w];
    if (digit !== 0)
      p = p * table[digit] % modulo;
  }
  return p;
}
function pow2(x, power, modulo) {
  if (modulo <= _1n2)
    throw new Error("pow2: expected modulus > 1, got " + modulo);
  if (power < _0n2)
    throw new Error("pow2: expected non-negative exponent, got " + power);
  let res = x;
  while (power-- > _0n2) {
    res *= res;
    res %= modulo;
  }
  return res;
}
function invert(number, modulo) {
  if (number === _0n2)
    throw new Error("invert: expected non-zero number");
  if (modulo <= _1n2)
    throw new Error("invert: expected modulus > 1, got " + modulo);
  let a = mod(number, modulo);
  let b = modulo;
  let x = _0n2, u = _1n2;
  while (a !== _0n2) {
    const q = b / a;
    const r = b - a * q;
    const m = x - u * q;
    b = a, a = r, x = u, u = m;
  }
  const gcd = b;
  if (gcd !== _1n2)
    throw new Error("invert: does not exist");
  return mod(x, modulo);
}
function assertIsSquare(Fp, root, n) {
  const F = Fp;
  if (!F.eql(F.sqr(root), n))
    throw new Error("Cannot find square root");
}
function aoddModulus(order, fnName) {
  if ((order & _1n2) === _0n2)
    throw new Error(fnName + ": expected odd modulus, got " + order);
}
function sqrt3mod4(Fp, n) {
  const F = Fp;
  const p1div4 = (F.ORDER + _1n2) / _4n;
  const root = F.pow(n, p1div4);
  assertIsSquare(F, root, n);
  return root;
}
function sqrt5mod8(Fp, n) {
  const F = Fp;
  const p5div8 = (F.ORDER - _5n) / _8n;
  const n2 = F.mul(n, _2n);
  const v = F.pow(n2, p5div8);
  const nv = F.mul(n, v);
  const i = F.mul(F.mul(nv, _2n), v);
  const root = F.mul(nv, F.sub(i, F.ONE));
  assertIsSquare(F, root, n);
  return root;
}
function sqrt9mod16(P) {
  const Fp_ = Field(P);
  const tn = tonelliShanks(P);
  const c1 = tn(Fp_, Fp_.neg(Fp_.ONE));
  const c2 = tn(Fp_, c1);
  const c3 = tn(Fp_, Fp_.neg(c1));
  const c4 = (P + _7n) / _16n;
  return (Fp, n) => {
    const F = Fp;
    let tv1 = F.pow(n, c4);
    let tv2 = F.mul(tv1, c1);
    const tv3 = F.mul(tv1, c2);
    const tv4 = F.mul(tv1, c3);
    const e1 = F.eql(F.sqr(tv2), n);
    const e2 = F.eql(F.sqr(tv3), n);
    tv1 = F.cmov(tv1, tv2, e1);
    tv2 = F.cmov(tv4, tv3, e2);
    const e3 = F.eql(F.sqr(tv2), n);
    const root = F.cmov(tv1, tv2, e3);
    assertIsSquare(F, root, n);
    return root;
  };
}
function tonelliShanks(P) {
  if (P < _3n)
    throw new Error("sqrt is not defined for small field");
  aoddModulus(P, "tonelliShanks");
  let Q = P - _1n2;
  let S = 0;
  while (Q % _2n === _0n2) {
    Q /= _2n;
    S++;
  }
  let Z = _2n;
  const _Fp = Field(P);
  while (FpLegendre(_Fp, Z) === 1) {
    if (Z++ > 1000)
      throw new Error("Cannot find square root: probably non-prime P");
  }
  if (S === 1)
    return sqrt3mod4;
  let cc = _Fp.pow(Z, Q);
  const Q1div2 = (Q + _1n2) / _2n;
  return function tonelliSlow(Fp, n) {
    const F = Fp;
    if (F.is0(n))
      return n;
    if (FpLegendre(F, n) !== 1)
      throw new Error("Cannot find square root");
    let M = S;
    let c = F.mul(F.ONE, cc);
    let t = F.pow(n, Q);
    let R = F.pow(n, Q1div2);
    while (!F.eql(t, F.ONE)) {
      if (F.is0(t))
        throw new Error("Cannot find square root: probably non-prime P");
      let i = 1;
      let t_tmp = F.sqr(t);
      while (!F.eql(t_tmp, F.ONE)) {
        i++;
        t_tmp = F.sqr(t_tmp);
        if (i === M)
          throw new Error("Cannot find square root");
      }
      const exponent = _1n2 << BigInt(M - i - 1);
      const b = F.pow(c, exponent);
      M = i;
      c = F.sqr(b);
      t = F.mul(t, c);
      R = F.mul(R, b);
    }
    return R;
  };
}
function FpSqrt(P) {
  aoddModulus(P, "Fp.sqrt");
  if (P % _4n === _3n)
    return sqrt3mod4;
  if (P % _8n === _5n)
    return sqrt5mod8;
  if (P % _16n === _9n)
    return sqrt9mod16(P);
  return tonelliShanks(P);
}
var isNegativeLE = (num, modulo) => (mod(num, modulo) & _1n2) === _1n2;
var FIELD_FIELDS = [
  "create",
  "isValid",
  "is0",
  "neg",
  "inv",
  "sqrt",
  "sqr",
  "eql",
  "add",
  "sub",
  "mul",
  "pow",
  "div",
  "addN",
  "subN",
  "mulN",
  "sqrN"
];
function validateField(field) {
  aobject2(field, "field");
  if (typeof field.ORDER !== "bigint")
    throw new TypeError('param "ORDER" is invalid: expected bigint, got ' + typeof field.ORDER);
  asafenumber(field.BYTES, "BYTES");
  asafenumber(field.BITS, "BITS");
  for (const name of FIELD_FIELDS)
    afunction(field[name], "field." + name);
  if (field.BYTES < 1 || field.BITS < 1)
    throw new Error("invalid field: expected BYTES/BITS > 0");
  if (field.ORDER <= _1n2)
    throw new Error("invalid field: expected ORDER > 1, got " + field.ORDER);
  return field;
}
function FpInvertBatch(Fp, nums, passZero = false) {
  validateField(Fp);
  aarray(nums, "nums");
  abool(passZero, "passZero");
  const F = Fp;
  const inverted = new Array(nums.length).fill(passZero ? F.ZERO : undefined);
  const multipliedAcc = nums.reduce((acc, num, i) => {
    if (F.is0(num))
      return acc;
    inverted[i] = acc;
    return F.mul(acc, num);
  }, F.ONE);
  const invertedAcc = F.inv(multipliedAcc);
  nums.reduceRight((acc, num, i) => {
    if (F.is0(num))
      return acc;
    inverted[i] = F.mul(acc, inverted[i]);
    return F.mul(acc, num);
  }, invertedAcc);
  return inverted;
}
function FpLegendre(Fp, n) {
  validateField(Fp);
  const F = Fp;
  aoddModulus(F.ORDER, "FpLegendre");
  const p1mod2 = (F.ORDER - _1n2) / _2n;
  const powered = F.pow(n, p1mod2);
  const yes = F.eql(powered, F.ONE);
  const zero = F.eql(powered, F.ZERO);
  const no = F.eql(powered, F.neg(F.ONE));
  if (!yes && !zero && !no)
    throw new Error("invalid Legendre symbol result");
  return yes ? 1 : zero ? 0 : -1;
}
function nLength(n, nBitLength) {
  if (nBitLength !== undefined)
    anumber2(nBitLength);
  if (n <= _0n2)
    throw new Error("invalid n length: expected positive n, got " + n);
  if (nBitLength !== undefined && nBitLength < 1)
    throw new Error("invalid n length: expected positive bit length, got " + nBitLength);
  const bits = bitLen(n);
  if (nBitLength !== undefined && nBitLength < bits)
    throw new Error(`invalid n length: expected nBitLength (${nBitLength}) >= bitLen(n) (${bits})`);
  const _nBitLength = nBitLength !== undefined ? nBitLength : bits;
  const nByteLength = Math.ceil(_nBitLength / 8);
  return { nBitLength: _nBitLength, nByteLength };
}
var FIELD_SQRT = new WeakMap;

class _Field {
  ORDER;
  BITS;
  BYTES;
  isLE;
  ZERO = _0n2;
  ONE = _1n2;
  _lengths;
  _mod;
  constructor(ORDER, opts = {}) {
    if (ORDER <= _1n2)
      throw new Error("invalid field: expected ORDER > 1, got " + ORDER);
    let _nbitLength = undefined;
    this.isLE = false;
    if (opts != null && typeof opts === "object") {
      if (typeof opts.BITS === "number")
        _nbitLength = opts.BITS;
      if (typeof opts.sqrt === "function")
        Object.defineProperty(this, "sqrt", { value: opts.sqrt, enumerable: true });
      if (typeof opts.isLE === "boolean")
        this.isLE = opts.isLE;
      if (opts.allowedLengths)
        this._lengths = Object.freeze(opts.allowedLengths.slice());
      if (typeof opts.modFromBytes === "boolean")
        this._mod = opts.modFromBytes;
    }
    const { nBitLength, nByteLength } = nLength(ORDER, _nbitLength);
    if (nByteLength > 2048)
      throw new Error("invalid field: expected ORDER of <= 2048 bytes");
    this.ORDER = ORDER;
    this.BITS = nBitLength;
    this.BYTES = nByteLength;
    Object.freeze(this);
  }
  create(num) {
    return mod(num, this.ORDER);
  }
  isValid(num) {
    if (typeof num !== "bigint")
      throw new TypeError("invalid field element: expected bigint, got " + typeof num);
    return _0n2 <= num && num < this.ORDER;
  }
  is0(num) {
    return num === _0n2;
  }
  isValidNot0(num) {
    return !this.is0(num) && this.isValid(num);
  }
  isOdd(num) {
    return (num & _1n2) === _1n2;
  }
  neg(num) {
    return mod(-num, this.ORDER);
  }
  eql(lhs, rhs) {
    return lhs === rhs;
  }
  sqr(num) {
    return mod(num * num, this.ORDER);
  }
  add(lhs, rhs) {
    return mod(lhs + rhs, this.ORDER);
  }
  sub(lhs, rhs) {
    return mod(lhs - rhs, this.ORDER);
  }
  mul(lhs, rhs) {
    return mod(lhs * rhs, this.ORDER);
  }
  pow(num, power) {
    return pow(num, power, this.ORDER);
  }
  div(lhs, rhs) {
    return mod(lhs * invert(rhs, this.ORDER), this.ORDER);
  }
  sqrN(num) {
    return num * num;
  }
  addN(lhs, rhs) {
    return lhs + rhs;
  }
  subN(lhs, rhs) {
    return lhs - rhs;
  }
  mulN(lhs, rhs) {
    return lhs * rhs;
  }
  inv(num) {
    return invert(num, this.ORDER);
  }
  sqrt(num) {
    let sqrt = FIELD_SQRT.get(this);
    if (!sqrt)
      FIELD_SQRT.set(this, sqrt = FpSqrt(this.ORDER));
    return sqrt(this, num);
  }
  toBytes(num) {
    return this.isLE ? numberToBytesLE(num, this.BYTES) : numberToBytesBE(num, this.BYTES);
  }
  fromBytes(bytes, skipValidation = false) {
    abytes2(bytes);
    const { _lengths: allowedLengths, BYTES, isLE, ORDER, _mod: modFromBytes } = this;
    if (allowedLengths) {
      if (bytes.length < 1 || !allowedLengths.includes(bytes.length) || bytes.length > BYTES) {
        throw new Error("Field.fromBytes: expected " + allowedLengths + " bytes, got " + bytes.length);
      }
      const padded = new Uint8Array(BYTES);
      padded.set(bytes, isLE ? 0 : padded.length - bytes.length);
      bytes = padded;
    }
    if (bytes.length !== BYTES)
      throw new Error("Field.fromBytes: expected " + BYTES + " bytes, got " + bytes.length);
    let scalar = isLE ? bytesToNumberLE(bytes) : bytesToNumberBE(bytes);
    if (modFromBytes)
      scalar = mod(scalar, ORDER);
    if (!skipValidation) {
      if (!this.isValid(scalar))
        throw new Error("invalid field element: outside of range 0..ORDER");
    }
    return scalar;
  }
  invertBatch(lst) {
    return FpInvertBatch(this, lst, true);
  }
  cmov(a, b, condition) {
    abool(condition, "condition");
    return condition ? b : a;
  }
}
function Field(ORDER, opts = {}) {
  Object.freeze(_Field.prototype);
  return new _Field(ORDER, opts);
}

// node_modules/@noble/curves/abstract/curve.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
var _0n3 = /* @__PURE__ */ BigInt(0);
var _1n3 = /* @__PURE__ */ BigInt(1);
var _4n2 = /* @__PURE__ */ BigInt(4);
var BLIND_BYTES = 16;
var BLIND_BITS = 128;
var FW_WINDOW = 5;
var TABLE_BYTES_MAX = /* @__PURE__ */ (() => 2 ** 31)();
function validatePointCons(Point) {
  const pc = Point;
  if (typeof pc !== "function")
    throw new TypeError('"Point" expected constructor, got type=' + typeof Point);
  afunction(pc.fromAffine, "Point.fromAffine");
  afunction(pc.fromBytes, "Point.fromBytes");
  afunction(pc.fromHex, "Point.fromHex");
  aobject2(pc.BASE, "Point.BASE");
  aobject2(pc.ZERO, "Point.ZERO");
  validateField(pc.Fp);
  validateField(pc.Fn);
}
function normalizeZ(c, points) {
  validatePointCons(c);
  validateMSMPoints(points, c);
  const invertedZs = FpInvertBatch(c.Fp, points.map((p) => p.Z));
  return points.map((p, i) => c.fromAffine(p.toAffine(invertedZs[i])));
}
function validateW(W, bits, min = 1) {
  if (!Number.isSafeInteger(W) || W < min || W > bits)
    throw new Error("invalid window size, expected [" + min + ".." + bits + "], got W=" + W);
}
function validateTableBytes(numPoints, fpBytes) {
  const bytes = numPoints * (4 * fpBytes + 128);
  if (bytes > TABLE_BYTES_MAX)
    throw new Error("invalid window size: table would need ~" + Math.ceil(bytes / 2 ** 20) + " MiB, max " + TABLE_BYTES_MAX / 2 ** 20 + " MiB");
}
function probeRandomBytes(randomBytes, length) {
  if (randomBytes === undefined)
    return;
  afunction(randomBytes, "randomBytes");
  try {
    const probe = randomBytes(length);
    if (!isBytes2(probe) || probe.length !== length)
      return;
  } catch {
    return;
  }
  return randomBytes;
}
function validateMSMPoints(points, c) {
  aarray(points, "points");
  points.forEach((p, i) => {
    if (!(p instanceof c))
      throw new Error("invalid point at index " + i);
  });
}
function validateMSMScalars(scalars, field, maxScalar) {
  if (!Array.isArray(scalars))
    throw new Error("array of scalars expected");
  scalars.forEach((s, i) => {
    const ok = maxScalar === undefined ? field.isValid(s) : isPosBig(s) && s < maxScalar;
    if (!ok)
      throw new Error("invalid scalar at index " + i);
  });
}
var pointWindowSizes = new WeakMap;
function getWindowSize(P) {
  return pointWindowSizes.get(P) || 1;
}
function oddMultiples(p, size) {
  const dbl = p.double();
  const t = [p];
  for (let j = 1;j < size; j++)
    t.push(t[j - 1].add(dbl));
  return t;
}
function wnafDigits(n, W) {
  const size = 2 ** W;
  const half = size / 2;
  const mask = BigInt(size - 1);
  const d = [];
  while (n > _0n3) {
    let w = 0;
    if (n & _1n3) {
      w = Number(n & mask);
      if (w >= half)
        w -= size;
      n -= BigInt(w);
    }
    d.push(w);
    n >>= _1n3;
  }
  return d;
}
function signedWindowDigits(n, W, windows) {
  const size = 2 ** W;
  const half = size / 2;
  const mask = BigInt(size - 1);
  const shiftBy = BigInt(W);
  const d = [];
  for (let w = 0;w < windows; w++) {
    let v = Number(n & mask);
    n >>= shiftBy;
    if (v > half) {
      v -= size;
      n += _1n3;
    }
    d.push(v);
  }
  if (n !== _0n3)
    throw new Error("invalid wnaf");
  return d;
}
function wnafWalk(zero, tables, digits) {
  let max = 0;
  for (const d of digits)
    max = Math.max(max, d.length);
  let acc = zero;
  for (let bit = max - 1;bit >= 0; bit--) {
    if (bit !== max - 1)
      acc = acc.double();
    for (let i = 0;i < digits.length; i++) {
      const w = digits[i][bit];
      if (w) {
        const item = tables[i][Math.abs(w) - 1 >> 1];
        acc = acc.add(w < 0 ? item.negate() : item);
      }
    }
  }
  return acc;
}

class ScalarMultiplier {
  Point;
  BASE;
  ZERO;
  randomBytes;
  wnafPrecomputes = new WeakMap;
  baseCanBeBlinded;
  bits;
  constructor(Point, randomBytes) {
    validatePointCons(Point);
    this.randomBytes = probeRandomBytes(randomBytes, BLIND_BYTES);
    this.Point = Point;
    this.BASE = Point.BASE;
    this.ZERO = Point.ZERO;
    this.bits = Point.Fn.BITS;
  }
  buildWnafTable(point, W, bits) {
    const windows = Math.ceil(bits / W) + 1;
    const half = 2 ** (W - 1);
    const comp = [];
    let base = point;
    for (let w = 0;w < windows; w++) {
      let acc = base;
      for (let i = 0;i < half; i++) {
        comp.push(acc);
        acc = acc.add(base);
      }
      base = comp[comp.length - 1].double();
    }
    return { W, bits, windows, comp };
  }
  wnafCachedCT(precomputes, n) {
    const { W, windows, comp } = precomputes;
    const half = 2 ** (W - 1);
    const digits = signedWindowDigits(n, W, windows);
    let p = this.ZERO;
    let f = this.BASE;
    for (let w = 0;w < windows; w++) {
      const digit = digits[w];
      const start = w * half;
      const idx = Math.abs(digit) - 1;
      let sel = comp[start];
      for (let i = 1;i < half; i++)
        sel = i === idx ? comp[start + i] : sel;
      const neg = sel.negate();
      if (digit === 0)
        f = f.add(comp[start]);
      else
        p = p.add(digit < 0 ? neg : sel);
    }
    return { p, f };
  }
  getWnafPrecomputes(W, point, bits, transform) {
    let entries = this.wnafPrecomputes.get(point);
    let comp = entries?.find((entry) => entry.W === W && entry.bits === bits);
    if (!comp) {
      comp = this.buildWnafTable(point, W, bits);
      if (typeof transform === "function")
        comp = { ...comp, comp: transform(comp.comp) };
      if (!entries) {
        entries = [];
        this.wnafPrecomputes.set(point, entries);
      }
      entries.push(comp);
    }
    return comp;
  }
  assertPoint(point) {
    if (!(point instanceof this.Point))
      throw new TypeError('"point" expected Point instance, got type=' + typeof point);
  }
  validateMulInput(point, scalar) {
    this.assertPoint(point);
    if (!inRange(scalar, _1n3, this.Point.Fn.ORDER))
      throw new Error("invalid scalar");
  }
  runCT(point, n, bits, transform) {
    const W = getWindowSize(point);
    if (W === 1)
      return this.fixedWindowCT(point, n, bits);
    return this.wnafCachedCT(this.getWnafPrecomputes(W, point, bits, transform), n);
  }
  mulCT(point, scalar, transform) {
    this.validateMulInput(point, scalar);
    return this.runCT(point, scalar, this.bits, transform);
  }
  mulCTBlinded(point, scalar, transform) {
    this.validateMulInput(point, scalar);
    if (this.randomBytes === undefined)
      throw new Error("randomBytes is required for scalar blinding");
    const bits = this.Point.Fn.BITS + BLIND_BITS;
    const blind = this.randomBytes(BLIND_BYTES);
    if (!isBytes2(blind) || blind.length !== BLIND_BYTES)
      throw new Error("randomBytes returned invalid byte array");
    blind[0] = blind[0] & 63 | 128;
    const n = scalar + bytesToNumberBE(blind) * this.Point.Fn.ORDER;
    return this.runCT(point, n, bits, transform);
  }
  fixedWindowCT(point, n, bits) {
    const W = FW_WINDOW;
    const size = 1 << W;
    const mask = bitMask(W);
    const table = new Array(size);
    table[0] = this.ZERO;
    for (let i = 1;i < size; i++)
      table[i] = table[i - 1].add(point);
    const windows = Math.ceil(bits / W);
    let acc = this.ZERO;
    for (let window = windows - 1;window >= 0; window--) {
      if (window !== windows - 1)
        for (let d = 0;d < W; d++)
          acc = acc.double();
      const digit = Number(n >> BigInt(window * W) & mask);
      let sel = table[0];
      for (let i = 1;i < size; i++)
        sel = i === digit ? table[i] : sel;
      acc = acc.add(sel);
    }
    return { p: acc, f: acc };
  }
  shouldBlind(point, cofactor) {
    if (this.randomBytes === undefined)
      return false;
    if (cofactor === _1n3)
      return true;
    if (point !== this.BASE)
      return false;
    if (this.baseCanBeBlinded === undefined)
      this.baseCanBeBlinded = this.mulUnsafe(this.BASE, this.Point.Fn.ORDER).is0();
    return this.baseCanBeBlinded;
  }
  mulSecret(point, scalar, cofactor, transform) {
    return this.shouldBlind(point, cofactor) ? this.mulCTBlinded(point, scalar, transform) : this.mulCT(point, scalar, transform);
  }
  mulUnsafe(point, scalar, transform) {
    this.assertPoint(point);
    if (!isPosBig(scalar))
      throw new Error("invalid scalar");
    const W = getWindowSize(point);
    if (W === 1 || scalar >= this.Point.Fn.ORDER)
      return mulAddUnsafe(this.Point, [point], [scalar], true);
    const precomputes = this.getWnafPrecomputes(W, point, this.bits, transform);
    return this.wnafCachedCT(precomputes, scalar).p;
  }
  setWindowSize(point, W) {
    this.assertPoint(point);
    validateW(W, this.bits);
    const windows = Math.ceil((this.bits + BLIND_BITS) / W) + 1;
    validateTableBytes(windows * 2 ** (W - 1), this.Point.Fp.BYTES);
    pointWindowSizes.set(point, W);
    this.wnafPrecomputes.delete(point);
  }
  hasWindowSize(point) {
    return getWindowSize(point) !== 1;
  }
}
function mulAddUnsafe(c, points, scalars, allowOversized = false) {
  validatePointCons(c);
  validateMSMPoints(points, c);
  abool(allowOversized, "allowOversized");
  validateMSMScalars(scalars, c.Fn, allowOversized ? c.Fn.ORDER ** _4n2 : undefined);
  if (points.length !== scalars.length)
    throw new Error("arrays of points and scalars must have equal length");
  const tables = points.map((p) => oddMultiples(p, 4));
  const digits = scalars.map((n) => wnafDigits(n, 4));
  return wnafWalk(c.ZERO, tables, digits);
}
function createField(order, field, isLE) {
  if (field) {
    if (field.ORDER !== order)
      throw new Error("Field.ORDER must match order: Fp == p, Fn == n");
    validateField(field);
    return field;
  } else {
    return Field(order, { isLE });
  }
}
function createCurveFields(type, CURVE, curveOpts = {}, FpFnLE) {
  if (type !== "weierstrass" && type !== "edwards")
    throw new Error('expected curve type "weierstrass" or "edwards"');
  if (FpFnLE === undefined)
    FpFnLE = type === "edwards";
  if (!CURVE || typeof CURVE !== "object")
    throw new Error(`expected valid ${type} CURVE object`);
  validateObject(curveOpts);
  for (const p of ["p", "n", "h"]) {
    const val = CURVE[p];
    if (!(isPosBig(val) && val !== _0n3))
      throw new Error(`CURVE.${p} must be positive bigint`);
  }
  const Fp = createField(CURVE.p, curveOpts.Fp, FpFnLE);
  const Fn = createField(CURVE.n, curveOpts.Fn, FpFnLE);
  const _b = type === "weierstrass" ? "b" : "d";
  const params = ["Gx", "Gy", "a", _b];
  for (const p of params) {
    if (!Fp.isValid(CURVE[p]))
      throw new Error(`CURVE.${p} must be valid field element of CURVE.Fp`);
  }
  CURVE = Object.freeze(Object.assign({}, CURVE));
  return { CURVE, Fp, Fn };
}

// node_modules/@noble/curves/abstract/edwards.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
var _0n4 = /* @__PURE__ */ BigInt(0);
var _1n4 = /* @__PURE__ */ BigInt(1);
var _2n2 = /* @__PURE__ */ BigInt(2);
var _4n3 = /* @__PURE__ */ BigInt(4);
var _8n2 = /* @__PURE__ */ BigInt(8);
function isEdValidXY(Fp, CURVE, x, y) {
  const x2 = Fp.sqr(x);
  const y2 = Fp.sqr(y);
  const left = Fp.add(Fp.mul(CURVE.a, x2), y2);
  const right = Fp.add(Fp.ONE, Fp.mul(CURVE.d, Fp.mul(x2, y2)));
  return Fp.eql(left, right);
}
function edwards(params, extraOpts = {}) {
  validateObject(extraOpts, {}, {}, "extraOpts");
  const opts = extraOpts;
  const validated = createCurveFields("edwards", params, opts, opts.FpFnLE);
  const { Fp, Fn } = validated;
  let CURVE = validated.CURVE;
  const { h: cofactor } = CURVE;
  if (FpLegendre(Fp, CURVE.a) !== 1)
    throw new Error("edwards: CURVE.a must be a square in Fp for complete addition formulas");
  if (FpLegendre(Fp, CURVE.d) !== -1)
    throw new Error("edwards: CURVE.d must be a non-square in Fp for complete addition formulas");
  validateObject(opts, {}, { uvRatio: "function", randomBytes: "function" });
  const randomBytes = opts.randomBytes === undefined ? randomBytes2 : opts.randomBytes;
  const MASK = _2n2 << BigInt(Fp.BYTES * 8) - _1n4;
  function isOdd(n) {
    if (!Fp.isOdd)
      throw new Error("Field does not have .isOdd()");
    return Fp.isOdd(n);
  }
  const uvRatio = opts.uvRatio === undefined ? (u, v) => {
    try {
      return { isValid: true, value: Fp.sqrt(Fp.div(u, v)) };
    } catch (e) {
      return { isValid: false, value: _0n4 };
    }
  } : opts.uvRatio;
  if (!isEdValidXY(Fp, CURVE, CURVE.Gx, CURVE.Gy))
    throw new Error("bad curve params: generator point");
  const mulA = Fp.eql(CURVE.a, Fp.neg(Fp.ONE)) ? (x) => Fp.neg(x) : Fp.eql(CURVE.a, Fp.ONE) ? (x) => x : (x) => Fp.mul(CURVE.a, x);
  function acoord(title, n, banZero = false) {
    const min = banZero ? _1n4 : _0n4;
    aInRange("coordinate " + title, n, min, MASK);
    return n;
  }
  function aedpoint(other) {
    if (!(other instanceof Point))
      throw new Error("EdwardsPoint expected");
  }

  class Point {
    static BASE = new Point(CURVE.Gx, CURVE.Gy, Fp.ONE, Fp.mul(CURVE.Gx, CURVE.Gy));
    static ZERO = new Point(Fp.ZERO, Fp.ONE, Fp.ONE, Fp.ZERO);
    static Fp = Fp;
    static Fn = Fn;
    X;
    Y;
    Z;
    T;
    constructor(X, Y, Z, T) {
      this.X = acoord("x", X);
      this.Y = acoord("y", Y);
      this.Z = acoord("z", Z, true);
      this.T = acoord("t", T);
      Object.freeze(this);
    }
    static CURVE() {
      return CURVE;
    }
    static fromAffine(p) {
      if (p instanceof Point)
        throw new Error("extended point not allowed");
      const { x, y } = p || {};
      acoord("x", x);
      acoord("y", y);
      return new Point(x, y, Fp.ONE, Fp.mul(x, y));
    }
    static fromBytes(bytes, zip215 = false) {
      const len = Fp.BYTES;
      const { a, d } = CURVE;
      bytes = copyBytes(abytes2(bytes, len, "point"));
      abool(zip215, "zip215");
      const normed = copyBytes(bytes);
      const lastByte = bytes[len - 1];
      normed[len - 1] = lastByte & ~128;
      const y = bytesToNumberLE(normed);
      const max = zip215 ? MASK : Fp.ORDER;
      aInRange("point.y", y, _0n4, max);
      const y2 = Fp.sqr(y);
      const u = Fp.sub(y2, Fp.ONE);
      const v = Fp.sub(Fp.mulN(d, y2), a);
      let { isValid, value: x } = uvRatio(u, v);
      if (!isValid)
        throw new Error("bad point: invalid y coordinate");
      const isXOdd = isOdd(x);
      const isLastByteOdd = (lastByte & 128) !== 0;
      if (!zip215 && Fp.is0(x) && isLastByteOdd)
        throw new Error("bad point: x=0 and x_0=1");
      if (isLastByteOdd !== isXOdd)
        x = Fp.neg(x);
      return Point.fromAffine({ x, y });
    }
    static fromHex(hex, zip215 = false) {
      return Point.fromBytes(hexToBytes2(hex), zip215);
    }
    get x() {
      return this.toAffine().x;
    }
    get y() {
      return this.toAffine().y;
    }
    precompute(windowSize = 6, isLazy = true) {
      wnaf.setWindowSize(this, windowSize);
      if (!isLazy)
        this.multiply(_2n2);
      return this;
    }
    assertValidity() {
      const p = this;
      const { a, d } = CURVE;
      if (p.is0())
        throw new Error("bad point: ZERO");
      const { X, Y, Z, T } = p;
      const X2 = Fp.sqr(X);
      const Y2 = Fp.sqr(Y);
      const Z2 = Fp.sqr(Z);
      const Z4 = Fp.sqr(Z2);
      const aX2 = Fp.mul(X2, a);
      const left = Fp.mul(Fp.add(aX2, Y2), Z2);
      const right = Fp.add(Z4, Fp.mul(d, Fp.mul(X2, Y2)));
      if (!Fp.eql(left, right))
        throw new Error("bad point: equation left != right (1)");
      const XY = Fp.mul(X, Y);
      const ZT = Fp.mul(Z, T);
      if (!Fp.eql(XY, ZT))
        throw new Error("bad point: equation left != right (2)");
    }
    equals(other) {
      aedpoint(other);
      const { X: X1, Y: Y1, Z: Z1 } = this;
      const { X: X2, Y: Y2, Z: Z2 } = other;
      const X1Z2 = Fp.mul(X1, Z2);
      const X2Z1 = Fp.mul(X2, Z1);
      const Y1Z2 = Fp.mul(Y1, Z2);
      const Y2Z1 = Fp.mul(Y2, Z1);
      return Fp.eql(X1Z2, X2Z1) && Fp.eql(Y1Z2, Y2Z1);
    }
    is0() {
      return this.equals(Point.ZERO);
    }
    negate() {
      return new Point(Fp.neg(this.X), this.Y, this.Z, Fp.neg(this.T));
    }
    double() {
      const { X: X1, Y: Y1, Z: Z1 } = this;
      const A = Fp.sqr(X1);
      const B = Fp.sqr(Y1);
      const C = Fp.mul(Fp.sqr(Z1), _2n2);
      const D = mulA(A);
      const x1y1 = Fp.addN(X1, Y1);
      const E = Fp.sub(Fp.subN(Fp.sqr(x1y1), A), B);
      const G = Fp.addN(D, B);
      const F = Fp.subN(G, C);
      const H = Fp.subN(D, B);
      const X3 = Fp.mul(E, F);
      const Y3 = Fp.mul(G, H);
      const T3 = Fp.mul(E, H);
      const Z3 = Fp.mul(F, G);
      return new Point(X3, Y3, Z3, T3);
    }
    add(other) {
      aedpoint(other);
      const { d } = CURVE;
      const { X: X1, Y: Y1, Z: Z1, T: T1 } = this;
      const { X: X2, Y: Y2, Z: Z2, T: T2 } = other;
      const A = Fp.mul(X1, X2);
      const B = Fp.mul(Y1, Y2);
      const C = Fp.mul(Fp.mulN(T1, d), T2);
      const D = Fp.mul(Z1, Z2);
      const E = Fp.sub(Fp.subN(Fp.mulN(Fp.addN(X1, Y1), Fp.addN(X2, Y2)), A), B);
      const F = Fp.subN(D, C);
      const G = Fp.addN(D, C);
      const H = Fp.sub(B, mulA(A));
      const X3 = Fp.mul(E, F);
      const Y3 = Fp.mul(G, H);
      const T3 = Fp.mul(E, H);
      const Z3 = Fp.mul(F, G);
      return new Point(X3, Y3, Z3, T3);
    }
    subtract(other) {
      aedpoint(other);
      return this.add(other.negate());
    }
    multiply(scalar) {
      if (!Fn.isValidNot0(scalar))
        throw new RangeError("invalid scalar: expected 1 <= sc < curve.n");
      const { p, f } = wnaf.mulSecret(this, scalar, cofactor, normalize);
      return normalize([p, f])[0];
    }
    multiplyUnsafe(scalar) {
      if (!Fn.isValid(scalar))
        throw new RangeError("invalid scalar: expected 0 <= sc < curve.n");
      if (scalar === _0n4)
        return Point.ZERO;
      if (this.is0() || scalar === _1n4)
        return this;
      return wnaf.mulUnsafe(this, scalar, normalize);
    }
    isSmallOrder() {
      return this.clearCofactor().is0();
    }
    isTorsionFree() {
      return wnaf.mulUnsafe(this, CURVE.n).is0();
    }
    toAffine(invertedZ) {
      const p = this;
      let iz = invertedZ;
      if (iz != null && typeof iz !== "bigint")
        throw new TypeError('"invertedZ" expected bigint, got type=' + typeof iz);
      const { X, Y, Z } = p;
      const is0 = p.is0();
      if (iz == null)
        iz = is0 ? Fp.create(_8n2) : Fp.inv(Z);
      const x = Fp.mul(X, iz);
      const y = Fp.mul(Y, iz);
      const zz = Fp.mul(Z, iz);
      if (is0)
        return { x: Fp.ZERO, y: Fp.ONE };
      if (!Fp.eql(zz, Fp.ONE))
        throw new Error("invZ was invalid");
      return { x, y };
    }
    clearCofactor() {
      if (cofactor === _1n4)
        return this;
      if (cofactor === _2n2)
        return this.double();
      if (cofactor === _4n3)
        return this.double().double();
      if (cofactor === _8n2)
        return this.double().double().double();
      return this.multiplyUnsafe(cofactor);
    }
    toBytes() {
      const { x, y } = this.toAffine();
      const bytes = Fp.toBytes(y);
      bytes[bytes.length - 1] |= isOdd(x) ? 128 : 0;
      return bytes;
    }
    toHex() {
      return bytesToHex2(this.toBytes());
    }
    toString() {
      return `<Point ${this.is0() ? "ZERO" : this.toHex()}>`;
    }
  }
  const normalize = (points) => normalizeZ(Point, points);
  const wnaf = new ScalarMultiplier(Point, randomBytes);
  if (wnaf.bits >= 6)
    Point.BASE.precompute(6);
  Object.freeze(Point.prototype);
  Object.freeze(Point);
  return Point;
}

class PrimeEdwardsPoint {
  static BASE;
  static ZERO;
  static Fp;
  static Fn;
  ep;
  constructor(ep) {
    this.ep = ep;
  }
  static fromBytes(_bytes) {
    notImplemented();
  }
  static fromHex(_hex) {
    notImplemented();
  }
  get x() {
    return this.toAffine().x;
  }
  get y() {
    return this.toAffine().y;
  }
  clearCofactor() {
    return this;
  }
  assertValidity() {
    this.ep.assertValidity();
  }
  toAffine(invertedZ) {
    return this.ep.toAffine(invertedZ);
  }
  toHex() {
    return bytesToHex2(this.toBytes());
  }
  toString() {
    return this.toHex();
  }
  isTorsionFree() {
    return true;
  }
  isSmallOrder() {
    return false;
  }
  add(other) {
    this.assertSame(other);
    return this.init(this.ep.add(other.ep));
  }
  subtract(other) {
    this.assertSame(other);
    return this.init(this.ep.subtract(other.ep));
  }
  multiply(scalar) {
    return this.init(this.ep.multiply(scalar));
  }
  multiplyUnsafe(scalar) {
    return this.init(this.ep.multiplyUnsafe(scalar));
  }
  double() {
    return this.init(this.ep.double());
  }
  negate() {
    return this.init(this.ep.negate());
  }
  precompute(windowSize, isLazy) {
    this.ep.precompute(windowSize, isLazy);
    return this;
  }
}

// node_modules/@noble/curves/abstract/hash-to-curve.js
function i2osp(value, length) {
  asafenumber(value);
  asafenumber(length);
  if (length < 0 || length > 4)
    throw new Error("invalid I2OSP length: " + length);
  if (value < 0 || value > 2 ** (8 * length) - 1)
    throw new Error("invalid I2OSP input: " + value);
  const res = Array.from({ length }).fill(0);
  for (let i = length - 1;i >= 0; i--) {
    res[i] = value & 255;
    value >>>= 8;
  }
  return new Uint8Array(res);
}
function strxor(a, b) {
  const arr = new Uint8Array(a.length);
  for (let i = 0;i < a.length; i++) {
    arr[i] = a[i] ^ b[i];
  }
  return arr;
}
function normDST(DST) {
  if (!isBytes2(DST) && typeof DST !== "string")
    throw new Error("DST must be Uint8Array or ascii string");
  const dst = typeof DST === "string" ? asciiToBytes(DST) : DST;
  if (dst.length === 0)
    throw new Error("DST must be non-empty");
  return dst;
}
function expand_message_xmd(msg, DST, lenInBytes, H) {
  abytes2(msg);
  asafenumber(lenInBytes);
  if (typeof H !== "function")
    throw new Error("expand_message_xmd: expected hash function");
  asafenumber(H.outputLen, "hash.outputLen");
  asafenumber(H.blockLen, "hash.blockLen");
  DST = normDST(DST);
  if (DST.length > 255)
    DST = H(concatBytes2(asciiToBytes("H2C-OVERSIZE-DST-"), DST));
  const { outputLen: b_in_bytes, blockLen: r_in_bytes } = H;
  const ell = Math.ceil(lenInBytes / b_in_bytes);
  if (lenInBytes > 65535 || ell > 255)
    throw new Error("expand_message_xmd: invalid lenInBytes");
  const DST_prime = concatBytes2(DST, i2osp(DST.length, 1));
  const Z_pad = new Uint8Array(r_in_bytes);
  const l_i_b_str = i2osp(lenInBytes, 2);
  const b = new Array(ell);
  const b_0 = H(concatBytes2(Z_pad, msg, l_i_b_str, i2osp(0, 1), DST_prime));
  b[0] = H(concatBytes2(b_0, i2osp(1, 1), DST_prime));
  for (let i = 1;i < ell; i++) {
    const args = [strxor(b_0, b[i - 1]), i2osp(i + 1, 1), DST_prime];
    b[i] = H(concatBytes2(...args));
  }
  const pseudo_random_bytes = concatBytes2(...b);
  return pseudo_random_bytes.slice(0, lenInBytes);
}
var _DST_scalar = "HashToScalar-";

// node_modules/@noble/curves/ed25519.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
var _1n5 = /* @__PURE__ */ BigInt(1);
var _2n3 = /* @__PURE__ */ BigInt(2);
var _5n2 = /* @__PURE__ */ BigInt(5);
var _8n3 = /* @__PURE__ */ BigInt(8);
var ed25519_CURVE_p = /* @__PURE__ */ BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed");
var ed25519_CURVE = /* @__PURE__ */ (() => ({
  p: ed25519_CURVE_p,
  n: BigInt("0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed"),
  h: _8n3,
  a: BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffec"),
  d: BigInt("0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3"),
  Gx: BigInt("0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51a"),
  Gy: BigInt("0x6666666666666666666666666666666666666666666666666666666666666658")
}))();
function ed25519_pow_2_252_3(x) {
  const _10n = BigInt(10), _20n = BigInt(20), _40n = BigInt(40), _80n = BigInt(80);
  const P = ed25519_CURVE_p;
  const x2 = x * x % P;
  const b2 = x2 * x % P;
  const b4 = pow2(b2, _2n3, P) * b2 % P;
  const b5 = pow2(b4, _1n5, P) * x % P;
  const b10 = pow2(b5, _5n2, P) * b5 % P;
  const b20 = pow2(b10, _10n, P) * b10 % P;
  const b40 = pow2(b20, _20n, P) * b20 % P;
  const b80 = pow2(b40, _40n, P) * b40 % P;
  const b160 = pow2(b80, _80n, P) * b80 % P;
  const b240 = pow2(b160, _80n, P) * b80 % P;
  const b250 = pow2(b240, _10n, P) * b10 % P;
  const pow_p_5_8 = pow2(b250, _2n3, P) * x % P;
  return { pow_p_5_8, b2 };
}
var ED25519_SQRT_M1 = /* @__PURE__ */ BigInt("19681161376707505956807079304988542015446066515923890162744021073123829784752");
function uvRatio(u, v) {
  const P = ed25519_CURVE_p;
  const v3 = mod(v * v * v, P);
  const v7 = mod(v3 * v3 * v, P);
  const pow = ed25519_pow_2_252_3(u * v7).pow_p_5_8;
  let x = mod(u * v3 * pow, P);
  const vx2 = mod(v * x * x, P);
  const root1 = x;
  const root2 = mod(x * ED25519_SQRT_M1, P);
  const useRoot1 = vx2 === u;
  const useRoot2 = vx2 === mod(-u, P);
  const noRoot = vx2 === mod(-u * ED25519_SQRT_M1, P);
  if (useRoot1)
    x = root1;
  if (useRoot2 || noRoot)
    x = root2;
  if (isNegativeLE(x, P))
    x = mod(-x, P);
  return { isValid: useRoot1 || useRoot2, value: x };
}
var ed25519_Point = /* @__PURE__ */ edwards(ed25519_CURVE, { uvRatio });
var Fp = /* @__PURE__ */ (() => ed25519_Point.Fp)();
var Fn = /* @__PURE__ */ (() => ed25519_Point.Fn)();
var SQRT_M1 = ED25519_SQRT_M1;
var SQRT_AD_MINUS_ONE = /* @__PURE__ */ BigInt("25063068953384623474111414158702152701244531502492656460079210482610430750235");
var INVSQRT_A_MINUS_D = /* @__PURE__ */ BigInt("54469307008909316920995813868745141605393597292927456921205312896311721017578");
var ONE_MINUS_D_SQ = /* @__PURE__ */ BigInt("1159843021668779879193775521855586647937357759715417654439879720876111806838");
var D_MINUS_ONE_SQ = /* @__PURE__ */ BigInt("40440834346308536858101042469323190826248399146238708352240133220865137265952");
var invertSqrt = (number) => uvRatio(_1n5, number);
var MAX_255B = /* @__PURE__ */ BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
var bytes255ToNumberLE = (bytes) => Fp.create(bytesToNumberLE(bytes) & MAX_255B);
function calcElligatorRistrettoMap(r0) {
  const { d } = ed25519_CURVE;
  const r = Fp.mul(Fp.mulN(SQRT_M1, r0), r0);
  const Ns = Fp.mul(Fp.addN(r, _1n5), ONE_MINUS_D_SQ);
  let c = BigInt(-1);
  const D = Fp.mul(Fp.subN(c, Fp.mulN(d, r)), Fp.add(r, d));
  let { isValid: Ns_D_is_sq, value: s } = uvRatio(Ns, D);
  let s_ = Fp.mul(s, r0);
  if (!Fp.isOdd(s_))
    s_ = Fp.neg(s_);
  if (!Ns_D_is_sq)
    s = s_;
  if (!Ns_D_is_sq)
    c = r;
  const Nt = Fp.sub(Fp.mulN(Fp.mulN(c, Fp.subN(r, _1n5)), D_MINUS_ONE_SQ), D);
  const s2 = Fp.sqrN(s);
  const W0 = Fp.mul(Fp.addN(s, s), D);
  const W1 = Fp.mul(Nt, SQRT_AD_MINUS_ONE);
  const W2 = Fp.sub(_1n5, s2);
  const W3 = Fp.add(_1n5, s2);
  return new ed25519_Point(Fp.mul(W0, W3), Fp.mul(W2, W1), Fp.mul(W1, W3), Fp.mul(W0, W2));
}

class _RistrettoPoint extends PrimeEdwardsPoint {
  static BASE = /* @__PURE__ */ (() => new _RistrettoPoint(ed25519_Point.BASE))();
  static ZERO = /* @__PURE__ */ (() => new _RistrettoPoint(ed25519_Point.ZERO))();
  static Fp = /* @__PURE__ */ (() => Fp)();
  static Fn = /* @__PURE__ */ (() => Fn)();
  constructor(ep) {
    super(ep);
  }
  static fromAffine(ap) {
    return new _RistrettoPoint(ed25519_Point.fromAffine(ap));
  }
  assertSame(other) {
    if (!(other instanceof _RistrettoPoint))
      throw new Error("RistrettoPoint expected");
  }
  init(ep) {
    return new _RistrettoPoint(ep);
  }
  static fromBytes(bytes) {
    abytes(bytes, 32);
    const { a, d } = ed25519_CURVE;
    const s = bytes255ToNumberLE(bytes);
    if (!equalBytes(Fp.toBytes(s), bytes) || Fp.isOdd(s))
      throw new Error("invalid ristretto255 encoding 1");
    const s2 = Fp.sqr(s);
    const u1 = Fp.add(_1n5, Fp.mulN(a, s2));
    const u2 = Fp.sub(_1n5, Fp.mulN(a, s2));
    const u1_2 = Fp.sqr(u1);
    const u2_2 = Fp.sqr(u2);
    const v = Fp.sub(Fp.mulN(Fp.mulN(a, d), u1_2), u2_2);
    const { isValid, value: I } = invertSqrt(Fp.mul(v, u2_2));
    const Dx = Fp.mul(I, u2);
    const Dy = Fp.mul(Fp.mulN(I, Dx), v);
    let x = Fp.mul(Fp.addN(s, s), Dx);
    if (Fp.isOdd(x))
      x = Fp.neg(x);
    const y = Fp.mul(u1, Dy);
    const t = Fp.mul(x, y);
    if (!isValid || Fp.isOdd(t) || Fp.is0(y))
      throw new Error("invalid ristretto255 encoding 2");
    return new _RistrettoPoint(new ed25519_Point(x, y, Fp.ONE, t));
  }
  static fromHex(hex) {
    return _RistrettoPoint.fromBytes(hexToBytes(hex));
  }
  toBytes() {
    let { X, Y, Z, T } = this.ep;
    const u1 = Fp.mul(Fp.add(Z, Y), Fp.sub(Z, Y));
    const u2 = Fp.mul(X, Y);
    const u2sq = Fp.sqr(u2);
    const { value: invsqrt } = invertSqrt(Fp.mul(u1, u2sq));
    const D1 = Fp.mul(invsqrt, u1);
    const D2 = Fp.mul(invsqrt, u2);
    const zInv = Fp.mul(Fp.mulN(D1, D2), T);
    let D;
    if (Fp.isOdd(Fp.mul(T, zInv))) {
      let _x = Fp.mul(Y, SQRT_M1);
      let _y = Fp.mul(X, SQRT_M1);
      X = _x;
      Y = _y;
      D = Fp.mul(D1, INVSQRT_A_MINUS_D);
    } else {
      D = D2;
    }
    if (Fp.isOdd(Fp.mul(X, zInv)))
      Y = Fp.neg(Y);
    let s = Fp.mul(Fp.subN(Z, Y), D);
    if (Fp.isOdd(s))
      s = Fp.neg(s);
    return Fp.toBytes(s);
  }
  equals(other) {
    this.assertSame(other);
    const { X: X1, Y: Y1 } = this.ep;
    const { X: X2, Y: Y2 } = other.ep;
    const one = Fp.eql(Fp.mul(X1, Y2), Fp.mul(Y1, X2));
    const two = Fp.eql(Fp.mul(Y1, Y2), Fp.mul(X1, X2));
    return one || two;
  }
  is0() {
    return this.equals(_RistrettoPoint.ZERO);
  }
}
var ristretto255 = /* @__PURE__ */ (() => {
  Object.freeze(_RistrettoPoint.BASE);
  Object.freeze(_RistrettoPoint.ZERO);
  Object.freeze(_RistrettoPoint.prototype);
  Object.freeze(_RistrettoPoint);
  return Object.freeze({ Point: _RistrettoPoint });
})();
var ristretto255_hasher = /* @__PURE__ */ Object.freeze({
  Point: _RistrettoPoint,
  hashToCurve(msg, options) {
    const DST = options?.DST === undefined ? "ristretto255_XMD:SHA-512_R255MAP_RO_" : options.DST;
    const xmd = expand_message_xmd(msg, DST, 64, sha512);
    return ristretto255_hasher.deriveToCurve(xmd);
  },
  hashToScalar(msg, options) {
    const DST = options?.DST === undefined ? _DST_scalar : options.DST;
    const xmd = expand_message_xmd(msg, DST, 64, sha512);
    return Fn.create(bytesToNumberLE(xmd));
  },
  deriveToCurve(bytes) {
    abytes(bytes, 64);
    const r1 = bytes255ToNumberLE(bytes.subarray(0, 32));
    const R1 = calcElligatorRistrettoMap(r1);
    const r2 = bytes255ToNumberLE(bytes.subarray(32, 64));
    const R2 = calcElligatorRistrettoMap(r2);
    return new _RistrettoPoint(R1.add(R2));
  }
});

// src/pake.ts
import crypto2 from "node:crypto";
var Point = ristretto255.Point;
var ORDER = 2n ** 252n + 27742317777372353535851937790883648493n;
var enc = new TextEncoder;
var b642 = (b) => Buffer.from(b).toString("base64");
var un642 = (s) => new Uint8Array(Buffer.from(s, "base64"));
function generator(phrase, sid) {
  const stretched = crypto2.scryptSync(phrase.trim().toLowerCase(), `crosstalk/cpace/${sid}`, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 256 * 1024 * 1024
  });
  return ristretto255_hasher.hashToCurve(new Uint8Array(Buffer.concat([Buffer.from("crosstalk/cpace/v1"), stretched])), { DST: "crosstalk-cpace-v1" });
}
var randomScalar = () => {
  const wide = crypto2.randomBytes(64);
  let n = 0n;
  for (const byte of wide)
    n = n << 8n | BigInt(byte);
  const s = n % (ORDER - 1n);
  return s + 1n;
};
function begin(phrase, sid) {
  const G = generator(phrase, sid);
  const x = randomScalar();
  return { secret: x, message: b642(G.multiply(x).toBytes()) };
}
function finish(half, theirMessage, sid, transcript) {
  let theirs;
  try {
    theirs = Point.fromBytes(un642(theirMessage));
  } catch {
    return null;
  }
  if (theirs.equals(Point.ZERO))
    return null;
  const shared = theirs.multiply(half.secret);
  const pair = [half.message, theirMessage].sort().join("|");
  return crypto2.createHash("sha256").update(enc.encode(`crosstalk/cpace/key/v1|${sid}|${pair}|${transcript}|`)).update(shared.toBytes()).digest();
}

// src/crypto.ts
var normalisePhrase = (p) => p.trim().toLowerCase().replace(/\s+/g, "-").replace(/-+/g, "-");
var SCRYPT2 = { N: 32768, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

// src/invite.ts
var DEFAULT_PORT = 8787;
function parseInvite(input) {
  const raw = input.trim().replace(/^["']|["']$/g, "");
  const [left, right] = raw.split(/\s+at\s+|\s*@\s*/i).map((s) => s?.trim());
  let phrase = normalisePhrase(left ?? "");
  let slot;
  const lead = phrase.match(/^([0-9]{3,6})-(.+)$/);
  if (lead) {
    slot = lead[1];
    phrase = lead[2];
  }
  if (!phrase || phrase.split("-").length < 3)
    throw new Error(`"${input}" does not look like an invite phrase (expected four words)`);
  if (!right)
    return { slot, phrase };
  const m = right.match(/^(.*?)(?::(\d{2,5}))?$/);
  return { slot, phrase, where: m?.[1] || right, port: m?.[2] ? Number(m[2]) : DEFAULT_PORT };
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
  relay: path2.join(ROOT2, "relay.json"),
  queue: path2.join(ROOT2, "queue.json"),
  parked: path2.join(ROOT2, "parked.json"),
  sessions: path2.join(ROOT2, "sessions.json"),
  outbox: path2.join(ROOT2, "outbox.json"),
  usage: path2.join(ROOT2, "usage.json"),
  routes: path2.join(ROOT2, "routes.json"),
  unrouted: path2.join(ROOT2, "unrouted.json"),
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
async function ensureCloudflared() {
  return onPath();
}
async function openTunnel(bin, port, logPath, timeoutMs = 60000) {
  fs3.writeFileSync(logPath, "");
  const out = fs3.openSync(logPath, "a");
  const child = spawn2(bin, ["tunnel", "--no-autoupdate", "--config", "/dev/null", "--url", `http://127.0.0.1:${port}`], {
    detached: true,
    stdio: ["ignore", out, out]
  });
  child.unref();
  const stop = () => {
    try {
      process.kill(child.pid);
    } catch {}
  };
  process.once("exit", stop);
  process.once("SIGINT", () => {
    stop();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    stop();
    process.exit(143);
  });
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
    stop();
    const asked = fs3.readFileSync(logPath, "utf8").includes("Requesting new quick Tunnel");
    throw new Error(asked ? `Cloudflare would not issue a tunnel. See ${logPath}

` + `It logged the request and never answered with a hostname, which is what
` + `their rate limit looks like: several quick tunnels from one machine in a
` + `short window stop being handed out. Wait, or run the relay yourself with
` + `--host and give the other person the address it prints.` : `cloudflared printed no URL. See ${logPath}`);
  }
  const host = `${found[1]}.trycloudflare.com`;
  const carrying = Date.now() + timeoutMs;
  while (Date.now() < carrying) {
    try {
      const r = await fetch(`https://${host}/health`, { signal: AbortSignal.timeout(1e4) });
      if (r.ok)
        return { url: found[0], host, subdomain: found[1], pid: child.pid };
    } catch {}
    await new Promise((r) => setTimeout(r, 1500));
  }
  stop();
  throw new Error(`the tunnel at ${host} never carried traffic. See ${logPath}

` + `If that hostname does not resolve at all, Cloudflare never published DNS
` + `for it. Quick tunnels are rate limited, so several in a few minutes stop
` + `being handed out. Wait a few minutes, or run the relay yourself with
` + `--host and give the other person the address it prints.`);
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
    return { ...DEFAULT_TRUST, rooms: {}, people: {}, muted: {} };
  }
}
function save(t) {
  fs5.mkdirSync(ROOT2, { recursive: true, mode: 448 });
  const tmp = `${FILE2}.tmp`;
  fs5.writeFileSync(tmp, JSON.stringify(t, null, 2), { mode: 384 });
  fs5.renameSync(tmp, FILE2);
}

// src/paths.ts
import path7 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var dirOf2 = (metaUrl) => path7.dirname(fileURLToPath2(metaUrl));
var rootFrom2 = (metaUrl) => path7.join(dirOf2(metaUrl), "..");
var shim2 = (root) => path7.join(root, "bin", "crosstalk");

// src/restore.ts
import fs6 from "node:fs";
import os4 from "node:os";
import path8 from "node:path";
import { spawn as spawn3, spawnSync } from "node:child_process";
var dir = () => path8.join(P2.root, "open");
var safe = (id) => id.replace(/[^A-Za-z0-9._-]/g, "_");
var fileOf = (id) => path8.join(dir(), `${safe(id)}.json`);
function readAll() {
  let names;
  try {
    names = fs6.readdirSync(dir()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const f of names) {
    try {
      const r = JSON.parse(fs6.readFileSync(path8.join(dir(), f), "utf8"));
      if (r && typeof r.sessionId === "string")
        out.push(r);
    } catch {}
  }
  return out;
}
function readOne(id) {
  try {
    return JSON.parse(fs6.readFileSync(fileOf(id), "utf8"));
  } catch {
    return null;
  }
}
function writeRec(r) {
  fs6.mkdirSync(dir(), { recursive: true, mode: 448 });
  const tmp = `${fileOf(r.sessionId)}.${process.pid}.tmp`;
  fs6.writeFileSync(tmp, JSON.stringify(r, null, 2), { mode: 384 });
  fs6.renameSync(tmp, fileOf(r.sessionId));
}
function removeRec(id) {
  try {
    fs6.unlinkSync(fileOf(id));
  } catch {}
}
var stateFile = () => path8.join(P2.root, "restore-state.json");
function loadState() {
  try {
    return JSON.parse(fs6.readFileSync(stateFile(), "utf8"));
  } catch {
    return {};
  }
}
function saveState(s) {
  fs6.mkdirSync(P2.root, { recursive: true, mode: 448 });
  fs6.writeFileSync(stateFile(), JSON.stringify(s, null, 2), { mode: 384 });
}
var DAY = 24 * 60 * 60 * 1000;
var WINDOW_MS = DAY;
var SHUTDOWN_MS = 10 * 60 * 1000;
var BURST_MS = 10 * 1000;
function bootTime(env = process.env, now = Date.now()) {
  const forced = Number(env.CROSSTALK_BOOT_TIME);
  if (forced > 0)
    return forced;
  return now - os4.uptime() * 1000;
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
    const r = spawnSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
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
      const r = spawnSync("tmux", ["display", "-p", "-t", env.TMUX_PANE, "#{session_name}\t#{window_index}\t#{pane_index}"], { encoding: "utf8", timeout: 2000, env });
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
      const r = spawnSync("osascript", ["-"], { input: appleLocateScript(t.tty), encoding: "utf8", timeout: 2500 });
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
  for (const [kind, rs] of byKind) {
    if (kind === "tmux") {
      const groups = groupBy(rs, (r) => r.terminal.tmux?.session ?? e.current.tmux?.session ?? "crosstalk");
      for (const [name, g] of groups) {
        const sorted = [...g].sort((a, b) => num(a.terminal.tmux?.window) - num(b.terminal.tmux?.window) || num(a.terminal.tmux?.paneIndex) - num(b.terminal.tmux?.paneIndex) || a.startedAt - b.startedAt);
        let exists = e.tmuxHasSession(name);
        const steps = sorted.map((r) => {
          const cmd = exec(r).map(shq).join(" ");
          if (!exists) {
            exists = true;
            return { cmd: "tmux", args: ["new-session", "-d", "-s", name, "-c", r.cwd, cmd] };
          }
          return { cmd: "tmux", args: ["new-window", "-d", "-t", `=${name}:`, "-c", r.cwd, cmd] };
        });
        plans.push({ kind: "tmux", sessions: sorted, steps });
      }
    } else if (kind === "apple") {
      const groups = groupBy(rs, (r) => String(r.terminal.apple?.window ?? "?"));
      const keys = [...groups.keys()].sort((a, b) => num(Number(a)) - num(Number(b)));
      for (const k of keys) {
        const g = [...groups.get(k)].sort((a, b) => num(a.terminal.apple?.tab) - num(b.terminal.apple?.tab) || a.startedAt - b.startedAt);
        const tabs = e.tabs && g.length > 1;
        plans.push({
          kind: "apple",
          sessions: g,
          needsAccessibility: tabs,
          steps: [{ cmd: "osascript", args: ["-"], input: appleTerminalScript(g.map(typed), tabs) }]
        });
      }
    } else if (kind === "iterm") {
      const groups = groupBy(rs, (r) => String(r.terminal.iterm?.window ?? "?"));
      for (const k of [...groups.keys()].sort((a, b) => num(Number(a)) - num(Number(b)))) {
        const g = [...groups.get(k)].sort((a, b) => num(a.terminal.iterm?.tab) - num(b.terminal.iterm?.tab) || a.startedAt - b.startedAt);
        plans.push({ kind: "iterm", sessions: g, steps: [{ cmd: "osascript", args: ["-"], input: itermScript(g.map(typed)) }] });
      }
    } else if (kind === "ghostty") {
      if (e.tabs)
        plans.push({ kind: "ghostty", sessions: rs, needsAccessibility: true, steps: [{ cmd: "osascript", args: ["-"], input: ghosttyScript(rs.map(typed)) }] });
      else
        plans.push({ kind: "manual", sessions: rs, steps: [] });
    } else if (kind === "kitty") {
      const to = e.current.kitty?.listenOn ?? rs[0].terminal.kitty?.listenOn;
      plans.push({
        kind: "kitty",
        sessions: rs,
        steps: rs.map((r) => ({ cmd: "kitten", args: ["@", "--to", to, "launch", "--type=tab", "--cwd", r.cwd, ...exec(r)] }))
      });
    } else if (kind === "wezterm") {
      plans.push({
        kind: "wezterm",
        sessions: rs,
        steps: rs.map((r) => ({ cmd: "wezterm", args: ["cli", "spawn", "--cwd", r.cwd, "--", ...exec(r)] }))
      });
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
  const r = spawnSync("osascript", ["-l", "JavaScript", "-e", JXA_AX], { encoding: "utf8", timeout: 3000 });
  const out = (r.stdout ?? "").trim();
  return out === "yes" ? true : out === "no" ? false : null;
}
var JXA_AUTOMATION = `ObjC.import("Foundation"); ObjC.import("CoreServices");
var d = $.NSAppleEventDescriptor.descriptorWithBundleIdentifier("com.apple.systemevents");
String($.AEDeterminePermissionToAutomateTarget(d.aeDesc, 0x2A2A2A2A, 0x2A2A2A2A, false))`;
function automationGranted() {
  if (process.platform !== "darwin")
    return null;
  const r = spawnSync("osascript", ["-l", "JavaScript", "-e", JXA_AUTOMATION], { encoding: "utf8", timeout: 3000 });
  const code = Number((r.stdout ?? "").trim());
  if (r.status !== 0 || Number.isNaN(code))
    return null;
  if (code === 0)
    return "yes";
  if (code === -1743)
    return "no";
  if (code === -1744)
    return "ask";
  return null;
}
function openSettings(pane) {
  if (process.env.CROSSTALK_NO_OPEN)
    return;
  spawnSync("open", [SETTINGS_URL[pane]], { timeout: 5000 });
}
function notify(text) {
  if (process.platform !== "darwin" || process.env.CROSSTALK_NO_OPEN)
    return;
  spawnSync("osascript", ["-e", `display notification ${asq(text)} with title "crosstalk"`], { timeout: 5000 });
}
function which(bin) {
  for (const d of (process.env.PATH ?? "").split(path8.delimiter)) {
    if (!d)
      continue;
    const p = path8.join(d, bin);
    try {
      fs6.accessSync(p, fs6.constants.X_OK);
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
    tmuxHasSession: (name) => spawnSync("tmux", ["has-session", "-t", `=${name}`], { stdio: "ignore", timeout: 2000 }).status === 0,
    tabs
  };
}
var label = (r) => r.name && !/^session-\d+$/.test(r.name) ? r.name : path8.basename(r.cwd) || r.sessionId.slice(0, 8);
var names = (rs, max = 4) => rs.slice(0, max).map(label).join(", ") + (rs.length > max ? ", \u2026" : "");
var commandsFile = () => path8.join(P2.root, "restore-commands.sh");
function ctxNow() {
  const now = Date.now();
  return { now, boot: bootTime(process.env, now), all: readAll(), alive: recAlive };
}
function describe(self, env = process.env, dry = false) {
  const lost = lostSessions(ctxNow(), self);
  if (!lost.length)
    return { ok: true, text: "\u25e2 crosstalk: nothing to restore.", lost, restored: [] };
  const lines = [`\u25e2 crosstalk: ${lost.length} session${lost.length === 1 ? "" : "s"} to restore:`];
  for (const r of lost)
    lines.push(`  ${label(r).padEnd(16)} ${r.cwd}  (${r.client}${resumeArgv(r) ? "" : ", cannot resume"})`);
  if (dry) {
    const { plans } = plan(lost, liveEnv(env, true));
    for (const p of plans) {
      lines.push("", `  ${p.kind}: ${p.sessions.map(label).join(", ")}${p.needsAccessibility ? "  (tabs need Accessibility)" : ""}`);
      if (p.kind === "manual")
        for (const r of p.sessions)
          lines.push(`    ${typed(r)}`);
      for (const s of p.steps) {
        lines.push(`    $ ${[s.cmd, ...s.args].map(shq).join(" ")}`);
        if (s.input)
          lines.push(...s.input.split(`
`).map((l) => `      ${l}`));
      }
    }
  }
  return { ok: true, text: lines.join(`
`), lost, restored: [] };
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
var pendingFile = () => path8.join(P2.root, "restore-pending.json");
function claimPending() {
  const mine = `${pendingFile()}.${process.pid}`;
  try {
    fs6.renameSync(pendingFile(), mine);
  } catch {
    return null;
  }
  try {
    return JSON.parse(fs6.readFileSync(mine, "utf8"));
  } catch {
    return null;
  } finally {
    try {
      fs6.unlinkSync(mine);
    } catch {}
  }
}
function runStep(s) {
  const r = spawnSync(s.cmd, s.args, { input: s.input, encoding: "utf8", timeout: 60000 });
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
    fs6.mkdirSync(P2.root, { recursive: true, mode: 448 });
    fs6.writeFileSync(pendingFile(), JSON.stringify(p), { mode: 384 });
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
    fs6.mkdirSync(P2.root, { recursive: true, mode: 448 });
    fs6.writeFileSync(commandsFile(), `#!/bin/sh
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
var POLL_MS = 2000;
function startWaiter(root) {
  if (process.env.CROSSTALK_NO_WAITER)
    return;
  try {
    const child = spawn3(shim(root ?? rootFrom(import.meta.url)), ["restore", "--finish"], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
  } catch {}
}
async function finishWhenPermitted() {
  let p = null;
  try {
    p = JSON.parse(fs6.readFileSync(pendingFile(), "utf8"));
  } catch {}
  if (!p)
    return "nothing pending";
  while (Date.now() < p.until) {
    if (accessibilityGranted() === true)
      break;
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (!fs6.existsSync(pendingFile()))
      return "taken over";
  }
  const mine = claimPending();
  if (!mine)
    return "taken over";
  if (accessibilityGranted() !== true) {
    notify(`No Accessibility permission yet, so nothing was reopened. Say "restore them" in any session to try again.`);
    return "timed out";
  }
  const recs = mine.ids.map(readOne).filter((r) => !!r);
  const env = { ...process.env, ...termEnv(mine.current) };
  const out = restore({ self: mine.self, env, userAction: false }, recs);
  notify(out.restored.length ? `Reopened ${out.restored.length} session${out.restored.length === 1 ? "" : "s"}.` : out.text);
  return out.text;
}
function termEnv(t) {
  const e = {};
  if (t.program)
    e.TERM_PROGRAM = t.program;
  if (t.apple?.sessionId)
    e.TERM_SESSION_ID = t.apple.sessionId;
  return e;
}

// src/gather.ts
import fs8 from "node:fs";
import os6 from "node:os";
import path10 from "node:path";
import { spawn as spawn5, spawnSync as spawnSync3 } from "node:child_process";

// src/restore.ts
import fs7 from "node:fs";
import os5 from "node:os";
import path9 from "node:path";
import { spawn as spawn4, spawnSync as spawnSync2 } from "node:child_process";
var dir2 = () => path9.join(P2.root, "open");
var safe2 = (id) => id.replace(/[^A-Za-z0-9._-]/g, "_");
var fileOf2 = (id) => path9.join(dir2(), `${safe2(id)}.json`);
function readAll2() {
  let names;
  try {
    names = fs7.readdirSync(dir2()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const f of names) {
    try {
      const r = JSON.parse(fs7.readFileSync(path9.join(dir2(), f), "utf8"));
      if (r && typeof r.sessionId === "string")
        out.push(r);
    } catch {}
  }
  return out;
}
function readOne2(id) {
  try {
    return JSON.parse(fs7.readFileSync(fileOf2(id), "utf8"));
  } catch {
    return null;
  }
}
function writeRec2(r) {
  fs7.mkdirSync(dir2(), { recursive: true, mode: 448 });
  const tmp = `${fileOf2(r.sessionId)}.${process.pid}.tmp`;
  fs7.writeFileSync(tmp, JSON.stringify(r, null, 2), { mode: 384 });
  fs7.renameSync(tmp, fileOf2(r.sessionId));
}
function removeRec2(id) {
  try {
    fs7.unlinkSync(fileOf2(id));
  } catch {}
}
var stateFile2 = () => path9.join(P2.root, "restore-state.json");
function loadState2() {
  try {
    return JSON.parse(fs7.readFileSync(stateFile2(), "utf8"));
  } catch {
    return {};
  }
}
function saveState2(s) {
  fs7.mkdirSync(P2.root, { recursive: true, mode: 448 });
  fs7.writeFileSync(stateFile2(), JSON.stringify(s, null, 2), { mode: 384 });
}
var DAY2 = 24 * 60 * 60 * 1000;
var WINDOW_MS2 = DAY2;
var SHUTDOWN_MS2 = 10 * 60 * 1000;
var BURST_MS2 = 10 * 1000;
function bootTime2(env = process.env, now = Date.now()) {
  const forced = Number(env.CROSSTALK_BOOT_TIME);
  if (forced > 0)
    return forced;
  return now - os5.uptime() * 1000;
}
function endedNormally2(r, all, boot) {
  if (!r.endedAt)
    return false;
  if (r.endReason !== "other")
    return true;
  if (r.endedAt < boot && boot - r.endedAt <= SHUTDOWN_MS2)
    return false;
  const burst = all.some((o) => o.sessionId !== r.sessionId && o.endReason === "other" && !!o.endedAt && Math.abs(o.endedAt - r.endedAt) <= BURST_MS2);
  return !burst;
}
function isLost2(r, c) {
  if (r.interactive === false)
    return false;
  if (endedNormally2(r, c.all, c.boot))
    return false;
  const before = r.seenAt < c.boot;
  const ref = before ? c.boot : c.now;
  if (ref - r.seenAt > WINDOW_MS2)
    return false;
  if (!before && r.client !== "claude")
    return false;
  return !c.alive(r);
}
function lostSessions2(c, self) {
  return order2(c.all.filter((r) => r.sessionId !== self && isLost2(r, c)));
}
var order2 = (rs) => [...rs].sort((a, b) => a.startedAt - b.startedAt);
function ps2(pid, field) {
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
var SHELL = /^-?(sh|bash|zsh|dash|fish|ksh|tcsh|csh)$/;
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
function captureTerminal2(env, pid, probe) {
  const t = {};
  if (env.TERM_PROGRAM)
    t.program = env.TERM_PROGRAM;
  const tty = ps2(pid, "tty");
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
      const r = spawnSync2("osascript", ["-"], { input: appleLocateScript2(t.tty), encoding: "utf8", timeout: 2500 });
      const [w, n] = (r.stdout ?? "").trim().split(" ").map(Number);
      if (r.status === 0 && w && n)
        Object.assign(t.apple, { window: w, tab: n });
    }
    if (env.TERM_PROGRAM !== "Apple_Terminal" && !t.apple.window)
      delete t.apple;
  }
  return t;
}
var shq2 = (s) => /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
var asq2 = (s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
function resumeArgv2(r, bin) {
  if (r.client === "claude")
    return [bin ?? "claude", "--resume", r.sessionId];
  if (r.client === "codex")
    return [bin ?? "codex", "resume", r.sessionId];
  return null;
}
var typed2 = (r) => `cd ${shq2(r.cwd)} && ${resumeArgv2(r).map(shq2).join(" ")}`;
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
function appName2(t) {
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
function usable2(k, e, t) {
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
function adapterFor2(r, e) {
  if (/[\n\r\0]/.test(r.cwd) || !r.cwd)
    return "manual";
  const own = kindOf2(r.terminal);
  if (own && usable2(own, e, r.terminal))
    return own;
  const cur = kindOf2(e.current);
  if (cur && usable2(cur, e, e.current))
    return cur;
  return "manual";
}
var groupBy2 = (xs, key) => {
  const m = new Map;
  for (const x of xs)
    m.set(key(x), [...m.get(key(x)) ?? [], x]);
  return m;
};
var num2 = (n) => n === undefined || Number.isNaN(n) ? Infinity : n;
function appleTerminalScript2(cmds, tabs) {
  const L = [`set crosstalkFallback to ""`, `tell application "Terminal"`, `	activate`, `	do script ${asq2(cmds[0])}`, `end tell`];
  for (const c of cmds.slice(1)) {
    if (!tabs) {
      L.push(`tell application "Terminal" to do script ${asq2(c)}`);
      continue;
    }
    L.push(`if crosstalkFallback is "" then`, `	try`, `		delay 0.3`, `		tell application "System Events" to keystroke "t" using command down`, `		delay 0.6`, `		tell application "Terminal" to do script ${asq2(c)} in selected tab of front window`, `	on error errMsg number errNum`, `		set crosstalkFallback to (errNum as text)`, `		tell application "Terminal" to do script ${asq2(c)}`, `	end try`, `else`, `	tell application "Terminal" to do script ${asq2(c)}`, `end if`);
  }
  L.push(`return "done " & crosstalkFallback`);
  return L.join(`
`);
}
function itermScript2(cmds) {
  const L = [`tell application "iTerm2"`, `	activate`, `	set w to (create window with default profile)`, `	tell current session of w to write text ${asq2(cmds[0])}`];
  for (const c of cmds.slice(1))
    L.push(`	tell w`, `		set t to (create tab with default profile)`, `		tell current session of t to write text ${asq2(c)}`, `	end tell`);
  L.push(`end tell`, `return "done "`);
  return L.join(`
`);
}
function ghosttyScript2(cmds) {
  const L = [`set crosstalkFallback to ""`, `tell application "Ghostty" to activate`, `delay 0.5`, `try`];
  cmds.forEach((c, i) => {
    L.push(`	tell application "System Events"`, `		keystroke ${i === 0 ? `"n"` : `"t"`} using command down`, `		delay 0.8`, `		keystroke ${asq2(c)}`, `		key code 36`, `	end tell`);
  });
  L.push(`on error errMsg number errNum`, `	set crosstalkFallback to (errNum as text)`, `end try`, `return "done " & crosstalkFallback`);
  return L.join(`
`);
}
var wtArg2 = (s) => s.replace(/;/g, "\\;");
function plan2(recs, e) {
  const skipped = recs.filter((r) => !resumeArgv2(r));
  const ok = order2(recs.filter((r) => resumeArgv2(r)));
  const byKind = groupBy2(ok, (r) => adapterFor2(r, e));
  const plans = [];
  const exec = (r) => resumeArgv2(r, e.which(r.client === "codex" ? "codex" : "claude"));
  for (const [kind, rs] of byKind) {
    if (kind === "tmux") {
      const groups = groupBy2(rs, (r) => r.terminal.tmux?.session ?? e.current.tmux?.session ?? "crosstalk");
      for (const [name, g] of groups) {
        const sorted = [...g].sort((a, b) => num2(a.terminal.tmux?.window) - num2(b.terminal.tmux?.window) || num2(a.terminal.tmux?.paneIndex) - num2(b.terminal.tmux?.paneIndex) || a.startedAt - b.startedAt);
        let exists = e.tmuxHasSession(name);
        const steps = sorted.map((r) => {
          const cmd = exec(r).map(shq2).join(" ");
          if (!exists) {
            exists = true;
            return { cmd: "tmux", args: ["new-session", "-d", "-s", name, "-c", r.cwd, cmd] };
          }
          return { cmd: "tmux", args: ["new-window", "-d", "-t", `=${name}:`, "-c", r.cwd, cmd] };
        });
        plans.push({ kind: "tmux", sessions: sorted, steps });
      }
    } else if (kind === "apple") {
      const groups = groupBy2(rs, (r) => String(r.terminal.apple?.window ?? "?"));
      const keys = [...groups.keys()].sort((a, b) => num2(Number(a)) - num2(Number(b)));
      for (const k of keys) {
        const g = [...groups.get(k)].sort((a, b) => num2(a.terminal.apple?.tab) - num2(b.terminal.apple?.tab) || a.startedAt - b.startedAt);
        const tabs = e.tabs && g.length > 1;
        plans.push({
          kind: "apple",
          sessions: g,
          needsAccessibility: tabs,
          steps: [{ cmd: "osascript", args: ["-"], input: appleTerminalScript2(g.map(typed2), tabs) }]
        });
      }
    } else if (kind === "iterm") {
      const groups = groupBy2(rs, (r) => String(r.terminal.iterm?.window ?? "?"));
      for (const k of [...groups.keys()].sort((a, b) => num2(Number(a)) - num2(Number(b)))) {
        const g = [...groups.get(k)].sort((a, b) => num2(a.terminal.iterm?.tab) - num2(b.terminal.iterm?.tab) || a.startedAt - b.startedAt);
        plans.push({ kind: "iterm", sessions: g, steps: [{ cmd: "osascript", args: ["-"], input: itermScript2(g.map(typed2)) }] });
      }
    } else if (kind === "ghostty") {
      if (e.tabs)
        plans.push({ kind: "ghostty", sessions: rs, needsAccessibility: true, steps: [{ cmd: "osascript", args: ["-"], input: ghosttyScript2(rs.map(typed2)) }] });
      else
        plans.push({ kind: "manual", sessions: rs, steps: [] });
    } else if (kind === "kitty") {
      const to = e.current.kitty?.listenOn ?? rs[0].terminal.kitty?.listenOn;
      plans.push({
        kind: "kitty",
        sessions: rs,
        steps: rs.map((r) => ({ cmd: "kitten", args: ["@", "--to", to, "launch", "--type=tab", "--cwd", r.cwd, ...exec(r)] }))
      });
    } else if (kind === "wezterm") {
      plans.push({
        kind: "wezterm",
        sessions: rs,
        steps: rs.map((r) => ({ cmd: "wezterm", args: ["cli", "spawn", "--cwd", r.cwd, "--", ...exec(r)] }))
      });
    } else if (kind === "wt") {
      plans.push({
        kind: "wt",
        sessions: rs,
        steps: rs.map((r) => ({ cmd: "wt", args: ["-w", "0", "nt", "-d", wtArg2(r.cwd), ...exec(r).map(wtArg2)] }))
      });
    } else {
      plans.push({ kind: "manual", sessions: rs, steps: [] });
    }
  }
  return { plans, skipped };
}
var SETTINGS_URL2 = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"
};
function classifyOsaError2(text) {
  if (/-1743\b|not authori[sz]ed to send apple events/i.test(text))
    return "automation";
  if (/-25211\b|-1719\b|^1002$|\(1002\)|assistive access|not allowed to send keystrokes|accessibility/i.test(text.trim()))
    return "accessibility";
  return null;
}
var REOPEN_SETTINGS_MS2 = 2 * 60 * 1000;
function shouldOpenSettings2(o) {
  if (!o.userAction)
    return false;
  const last = o.state.settingsOpened?.[o.pane];
  return !(last && o.now - last < REOPEN_SETTINGS_MS2);
}
function permissionSteps2(pane, app) {
  return pane === "accessibility" ? [
    `System Settings \u2192 Privacy & Security \u2192 Accessibility \u2192 turn on ${app}`,
    `open "${SETTINGS_URL2.accessibility}"`
  ] : [
    `System Settings \u2192 Privacy & Security \u2192 Automation \u2192 ${app} \u2192 turn on System Events`,
    `open "${SETTINGS_URL2.automation}"`
  ];
}
var JXA_AX2 = `ObjC.import("ApplicationServices"); var f; try { f = $.AXIsProcessTrusted() } catch (e) { ObjC.bindFunction("AXIsProcessTrusted", ["bool", []]); f = $.AXIsProcessTrusted() } f ? "yes" : "no"`;
function accessibilityGranted2() {
  if (process.platform !== "darwin")
    return null;
  const forced = process.env.CROSSTALK_FAKE_ACCESSIBILITY;
  if (forced)
    return forced === "yes";
  const r = spawnSync2("osascript", ["-l", "JavaScript", "-e", JXA_AX2], { encoding: "utf8", timeout: 3000 });
  const out = (r.stdout ?? "").trim();
  return out === "yes" ? true : out === "no" ? false : null;
}
function openSettings2(pane) {
  if (process.env.CROSSTALK_NO_OPEN)
    return;
  spawnSync2("open", [SETTINGS_URL2[pane]], { timeout: 5000 });
}
function which2(bin) {
  for (const d of (process.env.PATH ?? "").split(path9.delimiter)) {
    if (!d)
      continue;
    const p = path9.join(d, bin);
    try {
      fs7.accessSync(p, fs7.constants.X_OK);
      return p;
    } catch {}
  }
  return;
}
function liveEnv2(env, tabs) {
  return {
    platform: process.platform,
    current: captureTerminal2(env, process.pid, true),
    has: (b) => !!which2(b),
    which: which2,
    tmuxHasSession: (name) => spawnSync2("tmux", ["has-session", "-t", `=${name}`], { stdio: "ignore", timeout: 2000 }).status === 0,
    tabs
  };
}
var label2 = (r) => r.name && !/^session-\d+$/.test(r.name) ? r.name : path9.basename(r.cwd) || r.sessionId.slice(0, 8);
var names2 = (rs, max = 4) => rs.slice(0, max).map(label2).join(", ") + (rs.length > max ? ", \u2026" : "");
var commandsFile2 = () => path9.join(P2.root, "restore-commands.sh");
function ctxNow2() {
  const now = Date.now();
  return { now, boot: bootTime2(process.env, now), all: readAll2(), alive: recAlive2 };
}
var pendingFile2 = () => path9.join(P2.root, "restore-pending.json");
function claimPending2() {
  const mine = `${pendingFile2()}.${process.pid}`;
  try {
    fs7.renameSync(pendingFile2(), mine);
  } catch {
    return null;
  }
  try {
    return JSON.parse(fs7.readFileSync(mine, "utf8"));
  } catch {
    return null;
  } finally {
    try {
      fs7.unlinkSync(mine);
    } catch {}
  }
}
function runStep2(s) {
  const r = spawnSync2(s.cmd, s.args, { input: s.input, encoding: "utf8", timeout: 60000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}`.trim() };
}
function restore2(o, only) {
  const env = o.env ?? process.env;
  const lost = only ?? lostSessions2(ctxNow2(), o.self);
  if (!lost.length)
    return { ok: true, text: "\u25e2 crosstalk: nothing to restore.", lost, restored: [] };
  claimPending2();
  const e = liveEnv2(env, o.tabs ?? true);
  let { plans, skipped } = plan2(lost, e);
  const app = appName2(e.current);
  const notes = [];
  const state = loadState2();
  if (plans.some((p) => p.needsAccessibility) && accessibilityGranted2() === false) {
    const opened = shouldOpenSettings2({ pane: "accessibility", userAction: o.userAction, state, now: Date.now() });
    if (opened) {
      openSettings2("accessibility");
      saveState2({ ...state, settingsOpened: { ...state.settingsOpened, accessibility: Date.now() } });
    }
    const p = { ids: lost.map((r) => r.sessionId), current: e.current, until: Date.now() + WAIT_MS2(), self: o.self };
    fs7.mkdirSync(P2.root, { recursive: true, mode: 448 });
    fs7.writeFileSync(pendingFile2(), JSON.stringify(p), { mode: 384 });
    startWaiter2(o.root);
    const [steps, cmd] = permissionSteps2("accessibility", app);
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
    removeRec2(r.sessionId);
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
      const r = runStep2(s);
      out += r.out + `
`;
      if (!r.ok) {
        ok = false;
        break;
      }
    }
    const fellBack = /done (-?\d+)/.exec(out);
    if (ok && fellBack) {
      missing = classifyOsaError2(fellBack[1]) ?? "automation";
      notes.push(`Opened ${p.sessions.length} in ${app} as separate windows: ${app} ${missing === "accessibility" ? "may not type keys (Accessibility)" : "may not control System Events (Automation)"}.`);
    } else if (ok && p.needsAccessibility)
      saveState2({ ...loadState2(), tabsWorked: Date.now() });
    if (ok)
      restored.push(...p.sessions);
    else {
      missing ??= classifyOsaError2(out);
      failed.push(...p.sessions);
      notes.push(`${p.kind} could not open ${names2(p.sessions)}: ${out.trim().split(`
`).pop()}`);
    }
  }
  const rest = [...manual, ...failed];
  for (const r of failed)
    writeRec2(r);
  if (rest.length) {
    const lines = rest.map(typed2);
    fs7.mkdirSync(P2.root, { recursive: true, mode: 448 });
    fs7.writeFileSync(commandsFile2(), `#!/bin/sh
# Sessions crosstalk could not reopen by itself. Each line is one tab.
${lines.join(`
`)}
`, { mode: 448 });
    notes.push(`Paste each line into its own tab (also in ${commandsFile2()}):`, ...lines.map((l) => `  ${l}`));
  }
  if (skipped.length)
    notes.push(`Skipped ${names2(skipped)}: ${[...new Set(skipped.map((r) => r.client))].join(", ")} cannot resume a session.`);
  for (const r of skipped)
    removeRec2(r.sessionId);
  if (missing && process.platform === "darwin") {
    const opened = shouldOpenSettings2({ pane: missing, userAction: o.userAction, state: loadState2(), now: Date.now() });
    if (opened) {
      openSettings2(missing);
      const s = loadState2();
      saveState2({ ...s, settingsOpened: { ...s.settingsOpened, [missing]: Date.now() } });
    }
    const [steps, cmd] = permissionSteps2(missing, app);
    notes.push(opened ? `Opened System Settings, so next time they open as tabs: ${steps}` : `For tabs next time: ${steps}`, `  ${cmd}`);
  }
  const head = restored.length ? `\u25e2 crosstalk: reopened ${restored.length} session${restored.length === 1 ? "" : "s"} (${names2(restored)}).` : `\u25e2 crosstalk: reopened nothing.`;
  return { ok: !failed.length, text: [head, ...notes.map((n) => `  ${n}`)].join(`
`), lost, restored };
}
var WAIT_MS2 = () => Number(process.env.CROSSTALK_RESTORE_WAIT_MS ?? 2 * 60 * 1000);
function startWaiter2(root) {
  if (process.env.CROSSTALK_NO_WAITER)
    return;
  try {
    const child = spawn4(shim(root ?? rootFrom(import.meta.url)), ["restore", "--finish"], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
  } catch {}
}

// src/gather.ts
var registryDir = () => path10.join(os6.homedir(), ".claude", "sessions");
function readRegistry(dir = registryDir(), alive = (p) => pidAlive2(p)) {
  let files;
  try {
    files = fs8.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const e = JSON.parse(fs8.readFileSync(path10.join(dir, f), "utf8"));
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
    return new Set(fs8.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).map((f) => Number(f.slice(0, -5))));
  } catch {
    return new Set;
  }
}
function ps3(pid, field) {
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
    return parseEnv(fs8.readFileSync(`/proc/${pid}/environ`, "utf8"), /\0/);
  } catch {}
  if (process.platform !== "darwin")
    return null;
  try {
    const r = spawnSync3("ps", ["-wwE", "-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
    if (r.status !== 0)
      return null;
    return parseEnv(r.stdout.trim(), /\s+/);
  } catch {
    return null;
  }
}
function tmuxPanes() {
  const r = spawnSync3("tmux", ["list-panes", "-a", "-F", "#{pane_tty}\t#{pane_id}\t#{session_name}\t#{window_index}\t#{pane_index}\t#{socket_path}"], { encoding: "utf8", timeout: 2000 });
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
      const r = spawnSync3("osascript", ["-"], { input: appleLocateIfRunning(tty), encoding: "utf8", timeout: 2500 });
      const [w, n] = (r.stdout ?? "").trim().split(" ").map(Number);
      return r.status === 0 && w && n ? { window: w, tab: n } : null;
    },
    kill: (pid, sig) => process.kill(pid, sig),
    run: (s) => {
      const r = spawnSync3(s.cmd, s.args, { input: s.input, encoding: "utf8", timeout: 30000 });
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
var stateFile3 = () => path10.join(P2.root, "gather-state.json");
function loadState3() {
  try {
    return JSON.parse(fs8.readFileSync(stateFile3(), "utf8"));
  } catch {
    return {};
  }
}
function saveState3(s) {
  fs8.mkdirSync(P2.root, { recursive: true, mode: 448 });
  const tmp = `${stateFile3()}.${process.pid}.tmp`;
  fs8.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 384 });
  fs8.renameSync(tmp, stateFile3());
}
var sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function locked(fn) {
  const lock = path10.join(P2.root, "gather.lock");
  fs8.mkdirSync(P2.root, { recursive: true, mode: 448 });
  let held = false;
  for (let i = 0;i < 100 && !held; i++) {
    try {
      fs8.mkdirSync(lock);
      held = true;
    } catch {
      try {
        if (Date.now() - fs8.statSync(lock).mtimeMs > 1e4)
          fs8.rmdirSync(lock);
      } catch {}
      sleepSync(10);
    }
  }
  if (!held)
    return null;
  try {
    return fn();
  } finally {
    try {
      fs8.rmdirSync(lock);
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
var label3 = (r) => r.name && !/^session-\d+$/.test(r.name) ? r.name : path10.basename(r.cwd) || r.sessionId.slice(0, 8);
function addNote(session, text) {
  locked(() => {
    const s = loadState3();
    const now = Date.now();
    const notes = (s.notes ?? []).filter((n) => now - n.at < 24 * 60 * 60 * 1000);
    notes.push({ id: `gather-note:${now.toString(36)}`, session, text, at: now });
    saveState3({ ...s, notes });
  });
}
var appleInPlaceScript = (cmd, window, tab) => `tell application "Terminal" to do script ${asq2(cmd)} in tab ${tab} of window id ${window}`;
var itermInPlaceScript = (cmd, tty) => [
  `tell application "iTerm2"`,
  `	repeat with w in windows`,
  `		repeat with t in tabs of w`,
  `			repeat with s in sessions of t`,
  `				if (tty of s) is ${asq2(tty)} then`,
  `					tell s to write text ${asq2(cmd)}`,
  `					return "done"`,
  `				end if`,
  `			end repeat`,
  `		end repeat`,
  `	end repeat`,
  `end tell`,
  `error "no iTerm2 session on ${tty.replace(/["\\]/g, "")}"`
].join(`
`);
function inPlaceSteps(t, cmd, platform = process.platform) {
  if (/[\n\r\0]/.test(cmd))
    return null;
  if (t.tmux?.pane) {
    const S = t.tmux.socket ? ["-S", t.tmux.socket] : [];
    return {
      kind: "tmux",
      steps: [
        { cmd: "tmux", args: [...S, "send-keys", "-t", t.tmux.pane, "-l", cmd] },
        { cmd: "tmux", args: [...S, "send-keys", "-t", t.tmux.pane, "Enter"] }
      ]
    };
  }
  if (platform === "darwin" && t.program === "Apple_Terminal" && t.apple?.window && t.apple.tab)
    return { kind: "apple", steps: [{ cmd: "osascript", args: ["-"], input: appleInPlaceScript(cmd, t.apple.window, t.apple.tab) }] };
  if (platform === "darwin" && (t.program === "iTerm.app" || t.iterm) && t.tty)
    return { kind: "iterm", steps: [{ cmd: "osascript", args: ["-"], input: itermInPlaceScript(cmd, t.tty) }] };
  if (t.kitty?.window && t.kitty.listenOn)
    return { kind: "kitty", steps: [{ cmd: "kitten", args: ["@", "--to", t.kitty.listenOn, "send-text", "--match", `id:${t.kitty.window}`, `${cmd}\r`] }] };
  if (t.wezterm?.pane)
    return { kind: "wezterm", steps: [{ cmd: "wezterm", args: ["cli", "send-text", "--pane-id", t.wezterm.pane, "--no-paste", `${cmd}\r`] }] };
  return null;
}
async function endGracefully(pid, pidStart, sys, waits = [1e4, 5000, 5000]) {
  const sigs = ["SIGTERM", "SIGINT", "SIGINT"];
  for (let i = 0;i < sigs.length; i++) {
    if (!sys.alive(pid, pidStart))
      return true;
    try {
      sys.kill(pid, sigs[i]);
    } catch {
      return !sys.alive(pid, pidStart);
    }
    for (let waited = 0;waited < waits[i]; waited += 100) {
      if (!sys.alive(pid, pidStart))
        return true;
      await sys.sleep(100);
    }
  }
  return !sys.alive(pid, pidStart);
}
var job = () => path10.join(P2.root, "gather-job.json");
function loadJob() {
  try {
    return JSON.parse(fs8.readFileSync(job(), "utf8"));
  } catch {
    return null;
  }
}
function saveJob(j) {
  fs8.mkdirSync(P2.root, { recursive: true, mode: 448 });
  const tmp = `${job()}.${process.pid}.tmp`;
  fs8.writeFileSync(tmp, JSON.stringify(j, null, 2), { mode: 384 });
  fs8.renameSync(tmp, job());
}
var UNTIL_MS = () => Number(process.env.CROSSTALK_GATHER_UNTIL_MS ?? 2 * 60 * 60 * 1000);
var POLL_MS2 = () => Number(process.env.CROSSTALK_GATHER_POLL_MS ?? 2000);
async function restartOne(id, o) {
  const { sys } = o;
  const rec = readOne2(id);
  if (!rec || rec.adopted !== "watched")
    return "gone";
  if (id === o.self || o.selfPids.includes(rec.pid))
    return { failed: "it is the session asking" };
  const reg = o.registry.find((e) => e.sessionId === id);
  if (!reg || reg.pid !== rec.pid || !sys.alive(rec.pid, rec.pidStart))
    return "gone";
  if (reg.status !== "idle")
    return "wait";
  const args = sys.ps(rec.pid, "args") ?? "";
  if (!/claude/i.test(args))
    return { failed: "its process is not claude" };
  const parent = Number(sys.ps(rec.pid, "ppid"));
  const parentComm = path10.basename(sys.ps(parent, "comm") ?? "");
  const inShell = SHELL.test(parentComm);
  const cmd = typed2(rec);
  let term = rec.terminal;
  if (sys.platform === "darwin" && term.program === "Apple_Terminal" && term.tty) {
    const at = sys.appleLocate(term.tty);
    if (at)
      term = { ...term, apple: { ...term.apple, ...at } };
  }
  const how = inShell ? inPlaceSteps(term, cmd, sys.platform) : null;
  const ending = { ...rec, terminal: term, endedAt: sys.now(), endReason: "gather", gather: { state: "restarting", at: sys.now() } };
  writeRec2(ending);
  if (!await endGracefully(rec.pid, rec.pidStart, sys)) {
    const { endedAt, endReason, ...back } = ending;
    writeRec2({ ...back, gather: { state: "failed", at: sys.now() } });
    return { failed: "it did not exit" };
  }
  await sys.sleep(400);
  if (how) {
    let ok = true;
    for (const s of how.steps)
      if (!(ok = sys.run(s).ok))
        break;
    if (ok) {
      writeRec2({ ...ending, gather: { state: "done", at: sys.now() } });
      return "done";
    }
  }
  const back = { ...ending, endedAt: undefined, endReason: undefined };
  if (o.reopen(back)) {
    writeRec2({ ...ending, gather: { state: "done", at: sys.now() } });
    return "newTab";
  }
  return { failed: "it could not be reopened" };
}
function startWaiter3(root) {
  if (process.env.CROSSTALK_NO_WAITER)
    return;
  try {
    const child = spawn5(shim(root ?? rootFrom(import.meta.url)), ["gather", "--finish"], { detached: true, stdio: "ignore" });
    child.unref();
  } catch {}
}
function describe2(self) {
  watch(self);
  const cands = candidates(readAll2(), { self, selfPids: ancestors(), alive: recAlive2 });
  if (!cands.length)
    return { ok: true, text: "\u25e2 crosstalk: every running Claude session already has crosstalk.", sessions: [] };
  const reg = new Map(readRegistry().map((e) => [e.sessionId, e]));
  const lines = [`\u25e2 crosstalk: ${cands.length} Claude session${cands.length === 1 ? "" : "s"} started before crosstalk:`];
  for (const r of cands)
    lines.push(`  ${label3(r).padEnd(16)} ${r.cwd}  (${reg.get(r.sessionId)?.status ?? "unknown"})`);
  lines.push(`Bringing them in restarts each one in its own tab with its conversation, once it is idle.`);
  return { ok: true, text: lines.join(`
`), sessions: cands };
}
function start(o) {
  watch(o.self);
  const selfPids = ancestors();
  const cands = candidates(readAll2(), { self: o.self, selfPids, alive: recAlive2 });
  if (!cands.length)
    return { ok: true, text: "\u25e2 crosstalk: every running Claude session already has crosstalk.", sessions: [] };
  const before = loadJob();
  const pending = [...new Set([...before && before.until > Date.now() ? before.pending : [], ...cands.map((r) => r.sessionId)])];
  saveJob({
    by: o.self,
    selfPids: [...new Set([...selfPids, ...before?.selfPids ?? []])],
    pending,
    until: Date.now() + UNTIL_MS(),
    done: before?.until && before.until > Date.now() ? before.done : [],
    newTab: before?.until && before.until > Date.now() ? before.newTab : [],
    failed: []
  });
  for (const r of cands)
    writeRec2({ ...r, gather: { state: "queued", at: Date.now() } });
  locked(() => {
    const s = loadState3();
    saveState3({ ...s, offered: { at: Date.now(), by: o.self, ids: [...new Set([...s.offered?.ids ?? [], ...pending])] } });
  });
  startWaiter3(o.root);
  const reg = new Map(readRegistry().map((e) => [e.sessionId, e]));
  const busy = cands.filter((r) => reg.get(r.sessionId)?.status !== "idle");
  const n = cands.length;
  const idle = n - busy.length;
  const parts = [`\u25e2 crosstalk: bringing ${n} session${n === 1 ? "" : "s"} into crosstalk (${names3(cands)}).`];
  if (idle)
    parts.push(`${idle === n ? n === 1 ? "It is" : "They are" : `${idle} ${idle === 1 ? "is" : "are"}`} idle and restart${idle === 1 ? "s" : ""} in ${idle === 1 ? "its" : "their"} tab now, with ${idle === 1 ? "its" : "their"} conversation.`);
  if (busy.length)
    parts.push(`${busy.length === n ? n === 1 ? "It is" : "They are" : `${busy.length} ${busy.length === 1 ? "is" : "are"}`} busy (${names3(busy)}) and restart${busy.length === 1 ? "s" : ""} when ${busy.length === 1 ? "it goes" : "they go"} idle.`);
  return { ok: true, text: parts.join(" "), sessions: cands };
}
var names3 = (rs, max = 4) => rs.slice(0, max).map(label3).join(", ") + (rs.length > max ? ", \u2026" : "");
function receipt(j) {
  const n = j.done.length + j.newTab.length;
  const parts = [];
  if (n)
    parts.push(`${n} session${n === 1 ? " is" : "s are"} now in crosstalk.`);
  if (j.newTab.length)
    parts.push(`${j.newTab.length} could not be typed into ${j.newTab.length === 1 ? "its" : "their"} old tab, so ${j.newTab.length === 1 ? "it" : "they"} opened in a new one.`);
  if (j.failed.length)
    parts.push(`${j.failed.length} left as ${j.failed.length === 1 ? "it was" : "they were"}: ${j.failed.map((f) => f.why).join("; ")}.`);
  return parts.join(" ") || "No session needed bringing in.";
}
async function finish2(sys = liveSys()) {
  const lock = path10.join(P2.root, "gather-runner.pid");
  try {
    const other = Number(fs8.readFileSync(lock, "utf8"));
    if (other && other !== process.pid && pidAlive2(other))
      return "already running";
  } catch {}
  fs8.mkdirSync(P2.root, { recursive: true, mode: 448 });
  fs8.writeFileSync(lock, String(process.pid), { mode: 384 });
  try {
    for (;; ) {
      const j = loadJob();
      if (!j)
        return "nothing queued";
      if (!j.pending.length || sys.now() > j.until) {
        const left = j.pending;
        for (const id of left) {
          const r = readOne2(id);
          if (r?.gather?.state === "queued")
            writeRec2({ ...r, gather: undefined });
        }
        const text = receipt({ ...j, failed: [...j.failed, ...left.length ? [{ id: "", why: `${left.length} never went idle` }] : []] });
        if (j.done.length || j.newTab.length || j.failed.length || left.length) {
          addNote(j.by, `\u25e2 crosstalk: ${text}`);
          notify2(text);
        }
        try {
          fs8.unlinkSync(job());
        } catch {}
        return text;
      }
      const registry = readRegistry(registryDir(), (p) => sys.alive(p));
      for (const id of [...j.pending]) {
        const r = await restartOne(id, {
          self: j.by,
          selfPids: j.selfPids,
          sys,
          registry,
          reopen: (rec) => restore2({ self: j.by, userAction: false, tabs: true }, [rec]).restored.length > 0
        });
        if (r === "wait")
          continue;
        const cur = loadJob() ?? j;
        cur.pending = cur.pending.filter((x) => x !== id);
        if (r === "done")
          cur.done.push(id);
        else if (r === "newTab")
          cur.newTab.push(id);
        else if (typeof r === "object")
          cur.failed.push({ id, why: r.failed });
        saveJob(cur);
        Object.assign(j, cur);
      }
      if (loadJob()?.pending.length)
        await sys.sleep(POLL_MS2());
    }
  } finally {
    try {
      if (Number(fs8.readFileSync(lock, "utf8")) === process.pid)
        fs8.unlinkSync(lock);
    } catch {}
  }
}
function notify2(text) {
  if (process.platform !== "darwin" || process.env.CROSSTALK_NO_OPEN)
    return;
  spawnSync3("osascript", ["-e", `display notification ${asq2(text)} with title "crosstalk"`], { timeout: 5000 });
}

// src/client.ts
import net2 from "node:net";
import fs9 from "node:fs";
function request2(req, timeoutMs = 130000) {
  return new Promise((resolve, reject) => {
    const sock = net2.createConnection(P2.daemonSock);
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
function daemonRunning2() {
  try {
    const pid = Number(fs9.readFileSync(P2.daemonLock, "utf8"));
    process.kill(pid, 0);
    return fs9.existsSync(P2.daemonSock);
  } catch {
    return false;
  }
}

// src/uistate.ts
import fs10 from "node:fs";
import path11 from "node:path";
var FINAL = new Set(["answered", "handed", "muted"]);
var file = () => path11.join(P2.root, "ui.json");
var lockDir = () => path11.join(P2.root, "ui.lock");
var markers = () => path11.join(P2.root, "ui-mod");
var safe3 = (id) => id.replace(/[^A-Za-z0-9._-]/g, "_");
var WEEK = 7 * 24 * 60 * 60 * 1000;
function read() {
  try {
    const f = JSON.parse(fs10.readFileSync(file(), "utf8"));
    if (f && f.v === 1 && f.items && typeof f.items === "object")
      return f;
  } catch {}
  return { v: 1, items: {} };
}
function write(f) {
  fs10.mkdirSync(P2.root, { recursive: true, mode: 448 });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs10.writeFileSync(tmp, JSON.stringify(f, null, 2), { mode: 384 });
  fs10.renameSync(tmp, file());
}
var sleepSync2 = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function withStore(fn) {
  fs10.mkdirSync(P2.root, { recursive: true, mode: 448 });
  let held = false;
  for (let i = 0;i < 200 && !held; i++) {
    try {
      fs10.mkdirSync(lockDir());
      held = true;
    } catch {
      try {
        if (Date.now() - fs10.statSync(lockDir()).mtimeMs > 1e4)
          fs10.rmdirSync(lockDir());
      } catch {}
      sleepSync2(10);
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
        fs10.rmdirSync(lockDir());
      } catch {}
  }
}
function snapshot2() {
  return read().items;
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
function act(items, id, action, now, answer) {
  const it = items[id];
  if (!it)
    return { ok: false, error: `nothing waiting with id ${id}` };
  if (FINAL.has(it.state))
    return { ok: false, error: `already ${it.state}`, item: it };
  const next = { ...it, updatedAt: now };
  switch (action) {
    case "raised":
      next.raisedAt = now;
      break;
    case "later":
      next.state = "later";
      next.raisedAt = now;
      break;
    case "hand":
      if (it.kind !== "message" && it.kind !== "ask")
        return { ok: false, error: `a ${it.kind} cannot be handed over`, item: it };
      next.state = "handed";
      break;
    case "mute":
      next.state = "muted";
      break;
    case "answer":
      next.state = "answered";
      if (answer !== undefined)
        next.answer = answer;
      break;
    default:
      return { ok: false, error: `unknown action ${action}`, item: it };
  }
  items[id] = next;
  return { ok: true, item: next };
}
function settle(items, id, state, now) {
  const it = items[id];
  if (it && !FINAL.has(it.state))
    items[id] = { ...it, state, updatedAt: now };
}
function openFor(items, sessionId) {
  return Object.values(items).filter((i) => i.sessionId === sessionId && !FINAL.has(i.state)).sort((a, b) => a.createdAt - b.createdAt);
}
var MARKER_MS = 10 * 60 * 1000;
function markModActive(sessionId) {
  fs10.mkdirSync(markers(), { recursive: true, mode: 448 });
  fs10.writeFileSync(path11.join(markers(), safe3(sessionId)), String(Date.now()), { mode: 384 });
}
function modActive(sessionId, now = Date.now()) {
  try {
    return now - fs10.statSync(path11.join(markers(), safe3(sessionId))).mtimeMs < MARKER_MS;
  } catch {
    return false;
  }
}
function pruneMarkers(now = Date.now()) {
  try {
    for (const f of fs10.readdirSync(markers())) {
      const p = path11.join(markers(), f);
      try {
        if (now - fs10.statSync(p).mtimeMs > WEEK)
          fs10.unlinkSync(p);
      } catch {}
    }
  } catch {}
}
var restoreId = (sessionId) => `restore:${sessionId}`;
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

// src/gather.ts
import fs11 from "node:fs";
import os7 from "node:os";
import path12 from "node:path";
import { spawn as spawn6, spawnSync as spawnSync4 } from "node:child_process";
var registryDir2 = () => path12.join(os7.homedir(), ".claude", "sessions");
function readRegistry2(dir = registryDir2(), alive = (p) => pidAlive2(p)) {
  let files;
  try {
    files = fs11.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const e = JSON.parse(fs11.readFileSync(path12.join(dir, f), "utf8"));
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
function registryPids2(dir = registryDir2()) {
  try {
    return new Set(fs11.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).map((f) => Number(f.slice(0, -5))));
  } catch {
    return new Set;
  }
}
function ps4(pid, field) {
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
var ENV_KEYS2 = ["TERM_PROGRAM", "TERM_SESSION_ID", "TMUX", "TMUX_PANE", "KITTY_WINDOW_ID", "KITTY_LISTEN_ON", "WEZTERM_PANE", "ITERM_SESSION_ID", "WT_SESSION"];
function parseEnv2(text, sep) {
  const out = {};
  for (const part of text.split(sep)) {
    const i = part.indexOf("=");
    if (i < 1)
      continue;
    const k = part.slice(0, i);
    if (ENV_KEYS2.includes(k))
      out[k] = part.slice(i + 1);
  }
  return out;
}
function procEnv2(pid) {
  try {
    return parseEnv2(fs11.readFileSync(`/proc/${pid}/environ`, "utf8"), /\0/);
  } catch {}
  if (process.platform !== "darwin")
    return null;
  try {
    const r = spawnSync4("ps", ["-wwE", "-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
    if (r.status !== 0)
      return null;
    return parseEnv2(r.stdout.trim(), /\s+/);
  } catch {
    return null;
  }
}
function tmuxPanes2() {
  const r = spawnSync4("tmux", ["list-panes", "-a", "-F", "#{pane_tty}\t#{pane_id}\t#{session_name}\t#{window_index}\t#{pane_index}\t#{socket_path}"], { encoding: "utf8", timeout: 2000 });
  if (r.status !== 0)
    return [];
  return r.stdout.trim().split(`
`).filter(Boolean).map((l) => {
    const [tty, pane, session, w, p, socket] = l.split("\t");
    return { tty, pane, session, window: Number(w), paneIndex: Number(p), socket };
  });
}
var appleLocateIfRunning2 = (tty) => [`if application "Terminal" is running then`, ...appleLocateScript2(tty).split(`
`).slice(0, -1).map((l) => `	${l}`), `end if`, `return ""`].join(`
`);
function liveSys2() {
  return {
    platform: process.platform,
    now: Date.now,
    ps: ps4,
    alive: pidAlive2,
    env: procEnv2,
    tmuxPanes: tmuxPanes2,
    appleLocate: (tty) => {
      if (process.platform !== "darwin")
        return null;
      const r = spawnSync4("osascript", ["-"], { input: appleLocateIfRunning2(tty), encoding: "utf8", timeout: 2500 });
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
function terminalOf2(tty, env, sys, panes) {
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
var RECHECK_MS2 = 10 * 60 * 1000;
function snapshot3(o) {
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
    const fresh = same && now - (before.watchedAt ?? 0) < RECHECK_MS2;
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
      terminal: fresh ? before.terminal : terminalOf2(tty, sys.env(e.pid) ?? {}, sys, lazyPanes),
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
function watch2(self, sys = liveSys2()) {
  const recs = snapshot3({
    self,
    registry: readRegistry2(registryDir2(), (p) => sys.alive(p)),
    records: readAll2(),
    registryPids: registryPids2(),
    boot: bootTime2(process.env, sys.now()),
    sys
  });
  for (const r of recs)
    writeRec2(r);
  return recs;
}
var WATCH_EVERY_MS = () => Number(process.env.CROSSTALK_WATCH_EVERY_MS ?? 60000);
var stampFile = () => path12.join(P2.root, "watch-stamp");
function watchThrottled(self, now = Date.now()) {
  try {
    if (now - fs11.statSync(stampFile()).mtimeMs < WATCH_EVERY_MS())
      return false;
  } catch {}
  try {
    fs11.mkdirSync(P2.root, { recursive: true, mode: 448 });
    fs11.writeFileSync(stampFile(), String(now), { mode: 384 });
    watch2(self);
    return true;
  } catch {
    return false;
  }
}
var stateFile4 = () => path12.join(P2.root, "gather-state.json");
function loadState4() {
  try {
    return JSON.parse(fs11.readFileSync(stateFile4(), "utf8"));
  } catch {
    return {};
  }
}
function saveState4(s) {
  fs11.mkdirSync(P2.root, { recursive: true, mode: 448 });
  const tmp = `${stateFile4()}.${process.pid}.tmp`;
  fs11.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 384 });
  fs11.renameSync(tmp, stateFile4());
}
var sleepSync3 = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function locked2(fn) {
  const lock = path12.join(P2.root, "gather.lock");
  fs11.mkdirSync(P2.root, { recursive: true, mode: 448 });
  let held = false;
  for (let i = 0;i < 100 && !held; i++) {
    try {
      fs11.mkdirSync(lock);
      held = true;
    } catch {
      try {
        if (Date.now() - fs11.statSync(lock).mtimeMs > 1e4)
          fs11.rmdirSync(lock);
      } catch {}
      sleepSync3(10);
    }
  }
  if (!held)
    return null;
  try {
    return fn();
  } finally {
    try {
      fs11.rmdirSync(lock);
    } catch {}
  }
}
function ancestors2(pid = process.pid, sys = { ps: ps4 }) {
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
function candidates2(recs, o) {
  return recs.filter((r) => r.adopted === "watched" && !r.endedAt && r.interactive !== false && r.sessionId !== o.self && !(o.selfPids ?? []).includes(r.pid) && r.gather?.state !== "done" && o.alive(r)).sort((a, b) => a.startedAt - b.startedAt);
}
var offerQuestion = (n) => `${n} Claude session${n === 1 ? "" : "s"} started before crosstalk. Bring ${n === 1 ? "it" : "them"} in? Idle ones restart in their tab with their conversation.`;
function offerFor(cands, state) {
  const asked = new Set(state.offered?.ids ?? []);
  if (!cands.length || cands.every((r) => asked.has(r.sessionId)))
    return null;
  const n = cands.length;
  const names = cands.slice(0, 4).map(label4).concat(n > 4 ? ["\u2026"] : []);
  return {
    count: n,
    names,
    question: offerQuestion(n),
    text: `\u25e2 crosstalk: ${offerQuestion(n)} (${names.join(", ")}) Say "bring them in" to do it.`
  };
}
var label4 = (r) => r.name && !/^session-\d+$/.test(r.name) ? r.name : path12.basename(r.cwd) || r.sessionId.slice(0, 8);
function offerOnce(self) {
  const cands = candidates2(readAll2(), { self, selfPids: ancestors2(), alive: recAlive2 });
  if (!offerFor(cands, loadState4()))
    return null;
  return locked2(() => {
    const s = loadState4();
    const offer = offerFor(cands, s);
    if (!offer)
      return null;
    saveState4({ ...s, offered: { at: Date.now(), by: self, ids: [...new Set([...s.offered?.ids ?? [], ...cands.map((r) => r.sessionId)])] } });
    return offer;
  });
}
function takeNote(session, id) {
  if (!loadState4().notes?.some((n) => (!session || !n.session || n.session === session) && (!id || n.id === id)))
    return null;
  return locked2(() => {
    const s = loadState4();
    const i = (s.notes ?? []).findIndex((n) => (!session || !n.session || n.session === session) && (!id || n.id === id));
    if (i === -1)
      return null;
    const [n] = s.notes.splice(i, 1);
    saveState4(s);
    return { id: n.id, text: n.text };
  });
}
function peekNote(session) {
  const n = loadState4().notes?.find((x) => !x.session || x.session === session);
  return n ? { id: n.id, text: n.text } : null;
}
var job2 = () => path12.join(P2.root, "gather-job.json");
function loadJob2() {
  try {
    return JSON.parse(fs11.readFileSync(job2(), "utf8"));
  } catch {
    return null;
  }
}
function saveJob2(j) {
  fs11.mkdirSync(P2.root, { recursive: true, mode: 448 });
  const tmp = `${job2()}.${process.pid}.tmp`;
  fs11.writeFileSync(tmp, JSON.stringify(j, null, 2), { mode: 384 });
  fs11.renameSync(tmp, job2());
}
var UNTIL_MS2 = () => Number(process.env.CROSSTALK_GATHER_UNTIL_MS ?? 2 * 60 * 60 * 1000);
function startWaiter4(root) {
  if (process.env.CROSSTALK_NO_WAITER)
    return;
  try {
    const child = spawn6(shim(root ?? rootFrom(import.meta.url)), ["gather", "--finish"], { detached: true, stdio: "ignore" });
    child.unref();
  } catch {}
}
function start2(o) {
  watch2(o.self);
  const selfPids = ancestors2();
  const cands = candidates2(readAll2(), { self: o.self, selfPids, alive: recAlive2 });
  if (!cands.length)
    return { ok: true, text: "\u25e2 crosstalk: every running Claude session already has crosstalk.", sessions: [] };
  const before = loadJob2();
  const pending = [...new Set([...before && before.until > Date.now() ? before.pending : [], ...cands.map((r) => r.sessionId)])];
  saveJob2({
    by: o.self,
    selfPids: [...new Set([...selfPids, ...before?.selfPids ?? []])],
    pending,
    until: Date.now() + UNTIL_MS2(),
    done: before?.until && before.until > Date.now() ? before.done : [],
    newTab: before?.until && before.until > Date.now() ? before.newTab : [],
    failed: []
  });
  for (const r of cands)
    writeRec2({ ...r, gather: { state: "queued", at: Date.now() } });
  locked2(() => {
    const s = loadState4();
    saveState4({ ...s, offered: { at: Date.now(), by: o.self, ids: [...new Set([...s.offered?.ids ?? [], ...pending])] } });
  });
  startWaiter4(o.root);
  const reg = new Map(readRegistry2().map((e) => [e.sessionId, e]));
  const busy = cands.filter((r) => reg.get(r.sessionId)?.status !== "idle");
  const n = cands.length;
  const idle = n - busy.length;
  const parts = [`\u25e2 crosstalk: bringing ${n} session${n === 1 ? "" : "s"} into crosstalk (${names4(cands)}).`];
  if (idle)
    parts.push(`${idle === n ? n === 1 ? "It is" : "They are" : `${idle} ${idle === 1 ? "is" : "are"}`} idle and restart${idle === 1 ? "s" : ""} in ${idle === 1 ? "its" : "their"} tab now, with ${idle === 1 ? "its" : "their"} conversation.`);
  if (busy.length)
    parts.push(`${busy.length === n ? n === 1 ? "It is" : "They are" : `${busy.length} ${busy.length === 1 ? "is" : "are"}`} busy (${names4(busy)}) and restart${busy.length === 1 ? "s" : ""} when ${busy.length === 1 ? "it goes" : "they go"} idle.`);
  return { ok: true, text: parts.join(" "), sessions: cands };
}
var names4 = (rs, max = 4) => rs.slice(0, max).map(label4).join(", ") + (rs.length > max ? ", \u2026" : "");

// src/uicli.ts
function arg(argv, f) {
  const i = argv.indexOf(f);
  return i === -1 ? undefined : argv[i + 1];
}
var print = (o) => void process.stdout.write(JSON.stringify(o) + `
`);
async function waiting(session, mod) {
  if (daemonRunning2()) {
    try {
      const r = await request2({ op: "ui", sessionId: session, mod }, 3000);
      if (r?.ok)
        return { items: r.items, daemon: true, label: r.label };
    } catch {}
  }
  return { items: openFor(snapshot2(), session), daemon: false };
}
function settleRestore(session) {
  const id = restoreId(session);
  const it = snapshot2()[id];
  if (!it || FINAL.has(it.state))
    return;
  if (lostSessions2(ctxNow2(), session).length)
    return;
  withStore((items, now) => settle(items, id, "answered", now));
}
function tendGather(session) {
  if (process.env.CROSSTALK_NO_GATHER)
    return;
  watchThrottled(session);
  const id = gatherId(session);
  const it = snapshot2()[id];
  if (!it) {
    gatherSurface(session, offerOnce(session), true);
    return;
  }
  if (FINAL.has(it.state))
    return;
  const left = candidates2(readAll2(), { self: session, selfPids: ancestors2(), alive: recAlive2 });
  if (!left.some((r) => r.gather?.state !== "queued" && r.gather?.state !== "restarting"))
    withStore((items, now) => settle(items, id, "answered", now));
}
async function watch3(session, interval) {
  let last = "";
  let lastRestoreCheck = 0;
  const parent = process.ppid;
  for (;; ) {
    try {
      process.kill(parent, 0);
    } catch {
      return;
    }
    if (Date.now() - lastRestoreCheck > 1e4) {
      lastRestoreCheck = Date.now();
      try {
        settleRestore(session);
      } catch {}
      try {
        tendGather(session);
      } catch {}
    }
    const w = { ...await waiting(session, true), note: peekNote(session) ?? undefined };
    const line = JSON.stringify(w);
    if (line !== last) {
      last = line;
      process.stdout.write(line + `
`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}
function restoreAct(session, id, action, value, root) {
  if (action === "raised" || action === "later")
    return withStore((items, now) => act(items, id, action, now));
  const v = (value ?? "").trim();
  const want = action === "mute" || /^(not now|no|never|later)\b/i.test(v) ? "no" : /window/i.test(v) ? "windows" : "yes";
  const claim = withStore((items, now) => act(items, id, "answer", now, v || want));
  if (!claim.ok)
    return claim;
  if (want === "no")
    return { ok: true, item: claim.item, text: `Left them closed for now. Say "restore them" any time.` };
  const out = restore2({ self: session, tabs: want !== "windows", userAction: true, root });
  return { ok: out.ok, item: claim.item, text: out.text, restored: out.restored.length };
}
function gatherAct(session, id, action, value, root) {
  if (action === "raised" || action === "later")
    return withStore((items, now) => act(items, id, action, now));
  const v = (value ?? "").trim();
  const no = action === "mute" || /^(not now|no|never|later)\b/i.test(v);
  const claim = withStore((items, now) => act(items, id, "answer", now, v || (no ? "Not now" : "Bring them in")));
  if (!claim.ok)
    return claim;
  if (no)
    return { ok: true, item: claim.item, text: `Left them as they are. Say "bring my other sessions into crosstalk" any time.` };
  const out = start2({ self: session, root });
  return { ok: out.ok, item: claim.item, text: out.text, count: out.sessions.length };
}
async function uiCmd(argv, root) {
  const sub = argv[1];
  const session = arg(argv, "--session") ?? process.env.CLAUDE_CODE_SESSION_ID ?? "";
  if (!session)
    return print({ ok: false, error: "--session is needed" });
  switch (sub) {
    case "hello":
      markModActive(session);
      pruneMarkers();
      return print({ ok: true });
    case "list":
      return print({ ok: true, ...await waiting(session, false) });
    case "watch":
      return watch3(session, Math.max(250, Number(arg(argv, "--interval") ?? 1000)));
    case "act": {
      const id = arg(argv, "--id") ?? "";
      const action = arg(argv, "--action") ?? "";
      const value = arg(argv, "--value");
      if (id.startsWith("restore:"))
        return print(restoreAct(session, id, action, value, root));
      if (id.startsWith("gather:"))
        return print(gatherAct(session, id, action, value, root));
      if (id.startsWith("gather-note:")) {
        const n = takeNote(session, id);
        return print(n ? { ok: true, text: n.text } : { ok: false, error: "already shown" });
      }
      if (!daemonRunning2())
        return print({ ok: false, error: "the crosstalk daemon is not running" });
      try {
        return print(await request2({ op: "ui_act", sessionId: session, id, action, value }, 30000));
      } catch (e) {
        return print({ ok: false, error: e.message });
      }
    }
    default:
      return print({ ok: false, error: `unknown: crosstalk ui ${sub ?? ""}` });
  }
}

// src/cli.ts
import fs12 from "fs";
import path13 from "path";
import os8 from "os";
import { spawn as spawn7, execFileSync as execFileSync4 } from "child_process";
var argv = process.argv.slice(2);
var cmd = argv[0] ?? "status";
var VALUE_FLAGS = new Set([
  "--for",
  "--label",
  "--phrase",
  "--relay",
  "--port",
  "--address",
  "--in",
  "--because",
  "--intent",
  "--source",
  "--text"
]);
var DEFAULT_RELAY = process.env.CROSSTALK_DEFAULT_RELAY ?? "wss://crosstalk-relay.billowing-poetry-4cd6.workers.dev";
var heading = () => console.log(`
  \u25E2\u25E2\u25E2 crosstalk
`);
function refuseIfIdentityDamaged() {
  if (!identityUnreadable())
    return;
  die(`your identity file will not parse:
  ${P.identity}

` + `It holds the only copy of your private key, so nothing here will write
` + `over it. Restore it from a backup, or move it aside to start again as a
` + `new person, knowing every room you are in will not recognise you.`);
}
async function ready() {
  refuseIfIdentityDamaged();
  if (!loadIdentity())
    die(`crosstalk is not set up yet.

  /crosstalk:room new     start a room, and read the words to someone`);
  if (!await ensureDaemon(ROOT_DIR))
    die("the daemon would not start. See ~/.claude/crosstalk/daemon.log");
}
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
var RELAY_PID = path13.join(ROOT, "relay.pid");
var TUNNEL_PID = path13.join(ROOT, "tunnel.pid");
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
  refuseIfIdentityDamaged();
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
    const pid = Number(fs12.readFileSync(RELAY_PID, "utf8"));
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
    const url = loadRelay().url;
    if (await relayReachable(url))
      return url;
  }
  const out = fs12.openSync(path13.join(ROOT, "relay.log"), "a");
  const child = spawn7(shim2(ROOT_DIR), ["relay-server", "--host", "0.0.0.0", "--port", String(port)], {
    detached: true,
    stdio: ["ignore", out, out]
  });
  child.unref();
  fs12.mkdirSync(ROOT, { recursive: true, mode: 448 });
  fs12.writeFileSync(RELAY_PID, String(child.pid), { mode: 384 });
  const url = `ws://${addr.host}:${port}`;
  saveRelay(url);
  for (let i = 0;i < 40; i++) {
    if (await relayReachable(url, 500))
      break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (has("--public")) {
    const bin = await ensureCloudflared();
    if (!bin)
      die(`--public needs cloudflared, and it is not on your PATH.

  brew install cloudflared

Or drop --public and use --host, which runs the relay on this machine for
anyone on the same network.`);
    console.log("opening a public tunnel, this takes a few seconds");
    try {
      const t = await openTunnel(bin, port, path13.join(ROOT, "tunnel.log"));
      fs12.writeFileSync(TUNNEL_PID, String(t.pid), { mode: 384 });
      saveRelay(`wss://${t.host}`);
      console.log(`relay reachable at ${t.url}`);
      return `wss://${t.host}`;
    } catch (e) {
      die(`the tunnel did not come up: ${e.message}
See ${path13.join(ROOT, "tunnel.log")}`);
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
    fs12.rmSync(RELAY_PID, { force: true });
    try {
      process.kill(Number(fs12.readFileSync(TUNNEL_PID, "utf8")), "SIGTERM");
      fs12.rmSync(TUNNEL_PID, { force: true });
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
  xPub: id.x.pub,
  ...has("--agent") ? { isMachine: true } : {}
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
async function startRoom(words) {
  if (has("--relay"))
    saveRelay(flag("--relay"));
  const id = identityOrCreate();
  const joining = (words ?? positional.join(" ")).trim();
  const base = () => httpBase(loadRelay().url);
  const put = async (slot, part, blob) => {
    const r = await fetch(`${base()}/invite/${slot}?part=${part}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blob })
    });
    if (!r.ok)
      die(`the relay would not take part ${part} (${r.status})`);
  };
  const get = async (slot, part, waitMs = 0) => {
    const deadline = Date.now() + waitMs;
    for (;; ) {
      const r = await fetch(`${base()}/invite/${slot}?part=${part}`).catch(() => null);
      if (r?.ok)
        return (await r.json()).blob;
      if (Date.now() >= deadline)
        return null;
      await new Promise((res) => setTimeout(res, 1000));
    }
  };
  if (joining) {
    const inv = parseInvite(joining);
    if (!inv.slot)
      die("that invite is missing its number. It looks like 4821-otter-basalt-thunder-anvil.");
    if (inv.where) {
      for (const candidate of expandAddress(inv.where, inv.port ?? 8787))
        if (await relayReachable(candidate, 3000)) {
          saveRelay(candidate);
          break;
        }
    }
    if (!await relayReachable())
      die(`cannot reach a relay at ${base()}.`);
    const theirs = await get(inv.slot, "a");
    if (!theirs)
      die(`nothing is waiting on ${inv.slot}. Invites last fifteen minutes.`);
    const mine = begin(inv.phrase, inv.slot);
    const key = finish(mine, theirs, inv.slot, "crosstalk/room/v1");
    if (!key)
      die("that invite could not be used. Check the words.");
    await put(inv.slot, "b", mine.message + "." + seal(key, JSON.stringify(await myOffer(id))));
    const back = await get(inv.slot, "c", 120000);
    if (!back)
      die("the other side never answered. Ask them to start again.");
    let peer;
    try {
      peer = asPeer(JSON.parse(open(key, back)));
    } catch {
      return die("could not read what they sent. Somebody may be interfering; start again.");
    }
    const localName = adoptPeer(peer);
    peer.label = localName;
    if (peer.relayPub)
      saveRelay(loadRelay().url, peer.relayPub);
    await ensureDaemon(ROOT_DIR);
    console.log(`
Now in a room with "${peer.label}"${peer.isMachine ? ", a machine rather than a person" : ""}.

  them  ${peer.fingerprint}
  you   ${fingerprint(id.ed.pub)}

Read them aloud. Your "them" should be their "you", and theirs should be
yours. If both cross over, nobody is in the middle.

They start at "ask": they can put a line on your screen, and their agent can ask
yours a question. Their words never enter your session unless you raise them.

  /crosstalk:trust`);
    return;
  }
  const url = has("--host") || has("--public") ? await startRelay() : loadRelay().url;
  if (!await relayReachable(url))
    die(`no relay at ${httpBase(url)}.

Run this instead and crosstalk will host one for you:
  /crosstalk:room new --host`);
  const slotRes = await fetch(`${httpBase(url)}/slot`, { method: "POST" }).catch(() => null);
  if (!slotRes?.ok)
    die("the relay would not give out a slot. Try again in a moment.");
  const { slot } = await slotRes.json();
  const phrase = flag("--phrase") ?? newPhrase(4);
  const mine = begin(phrase, slot);
  await put(slot, "a", mine.message);
  const asHttp = new URL(url.replace(/^ws/, "http"));
  const where = url === DEFAULT_RELAY ? null : `${asHttp.hostname}${asHttp.port ? ":" + asHttp.port : ""}`;
  const invite = `${slot}-${phrase}${where ? ` at ${where}` : ""}`;
  console.log(`
Tell them this:

    ${invite}

They run  /crosstalk:room join ${invite}

Say it out loud, or send it somewhere you already trust. The number is public;
the words are the secret. They work once and expire in fifteen minutes.

  you       ${id.label}  ${fingerprint(id.ed.pub)}
  reaches   ${where ? "same network" : "anywhere"}

Waiting\u2026`);
  const theirs = await get(slot, "b", 900000);
  if (!theirs)
    die("that invite expired without anyone using it");
  const dot = theirs.indexOf(".");
  const key = finish(mine, theirs.slice(0, dot), slot, "crosstalk/room/v1");
  if (!key)
    die("somebody tried to join with the wrong words. Start again with a new invite.");
  let peer;
  try {
    peer = asPeer(JSON.parse(open(key, theirs.slice(dot + 1))));
  } catch {
    return die("could not read what they sent. Somebody may be interfering; start again.");
  }
  if (peer.fingerprint === fingerprint(id.ed.pub))
    die("that reply carries your own key");
  const relayPub = await relayPubkey(url);
  if (relayPub)
    saveRelay(url, relayPub);
  await put(slot, "c", seal(key, JSON.stringify({ ...await myOffer(id), relayPub })));
  peer.label = adoptPeer(peer);
  await ready();
  console.log(`
Now in a room with "${peer.label}"${peer.isMachine ? ", a machine rather than a person" : ""}.

  them  ${peer.fingerprint}
  you   ${fingerprint(id.ed.pub)}

Read them aloud. Your "them" should be their "you", and theirs should be
yours. If both cross over, nobody is in the middle.

They start at "ask": a line on your screen, and their agent may ask yours a
question. Nothing they do puts their words inside your turn.

  /crosstalk:trust`);
}
async function peers() {
  await ready();
  const r = await request({ op: "peers" });
  heading();
  console.log(`  you   ${r.me.label}   relay ${r.relay}`);
  for (const s of r.me.sessions)
    console.log(`        ${s.name}  ${s.cwd}  ${s.status}`);
  if (!r.peers.length) {
    console.log(`
  Nobody yet. Run /crosstalk:room new and read the words to someone.
`);
    return;
  }
  for (const p of r.peers) {
    console.log(`
  ${p.online ? "\u25CF" : "\u25CB"} ${p.label}${p.isMachine ? " (a machine)" : ""}  ${p.fingerprint}  ${p.level}${p.muted ? " (muted)" : ""}${p.unread ? `  ${p.unread} unread` : ""}`);
    if (!p.sessions.length)
      console.log(`        no sessions reported  (presence ${ago(p.presenceAt)})`);
    for (const s of p.sessions)
      console.log(`        ${s.name}  ${s.cwd}  ${s.status}  ${ago(s.lastSeen)}`);
  }
  console.log();
}
async function mute() {
  const peer = positional[0] && !/^\d+$/.test(positional[0]) ? positional[0] : undefined;
  const minutes = Number(positional.find((a) => /^\d+$/.test(a)) ?? 60);
  await ready();
  const r = await request({ op: "mute", peer, minutes });
  console.log(r.mutedUntil ? `muted ${peer ?? `all ${r.muted.length} peer(s)`} until ${new Date(r.mutedUntil).toLocaleTimeString()}` : `unmuted ${peer ?? "everyone"}`);
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
  if (identityUnreadable())
    return refuseIfIdentityDamaged();
  if (!id)
    return console.log("crosstalk: not set up. Run /crosstalk:room new.");
  heading();
  console.log(`  identity  ${id.label}  ${fingerprint(id.ed.pub)}`);
  console.log(`  relay     ${loadRelay().url}`);
  console.log(`  peers     ${Object.keys(loadPeers()).join(", ") || "none"}`);
  if (!daemonRunning())
    return console.log(`  daemon    not running
`);
  const r = await request({ op: "status" });
  console.log(`  daemon    running, relay ${r.relay}`);
  for (const s of r.sessions)
    console.log(`            ${s.name}  ${s.cwd}`);
  console.log();
}
async function doctor() {
  const rows = [];
  const id = loadIdentity();
  const socket = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  rows.push(["runtime", true, `${path13.basename(process.execPath)} ${process.version ?? ""}`.trim()]);
  rows.push([
    "identity",
    !!id,
    id ? `${id.label}  ${fingerprint(id.ed.pub)}` : identityUnreadable() ? `${P.identity} will not parse. Restore it from a backup rather than starting again.` : "none, run /crosstalk:room new"
  ]);
  rows.push([
    "peers",
    Object.keys(loadPeers()).length > 0,
    Object.keys(loadPeers()).join(", ") || "no rooms yet"
  ]);
  rows.push([
    "inbox socket",
    socket ? fs12.existsSync(socket) : null,
    socket ?? "not provided; sessions without a Claude Code socket receive notices through hooks"
  ]);
  rows.push([
    "messaging token",
    socket ? !!process.env.CLAUDE_CODE_MESSAGING_TOKEN : null,
    process.env.CLAUDE_CODE_MESSAGING_TOKEN ? "present" : socket ? "missing, messages arrive as anonymous peers" : "only used with a Claude Code inbox socket"
  ]);
  const sessionsDir = path13.join(process.env.HOME ?? "", ".claude", "sessions");
  let visible = 0;
  try {
    visible = fs12.readdirSync(sessionsDir).filter((f) => f.endsWith(".json")).length;
  } catch {}
  rows.push(["session registry", visible > 0 ? true : null, `${visible} Claude Code entries in ${sessionsDir}`]);
  {
    const live = daemonRunning();
    let count;
    try {
      const output = execFileSync4("lsof", ["-nP", "-U", "-Fpn"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000
      });
      const owners = new Set;
      let pid = "";
      for (const line of output.split(`
`)) {
        if (line.startsWith("p"))
          pid = line.slice(1);
        if (line === `n${P.daemonSock}` && pid)
          owners.add(pid);
      }
      count = owners.size;
    } catch {}
    rows.push([
      "daemon",
      live && (count === undefined || count <= 1),
      !live ? "not running; it starts on its own with the next hook or tool call" : count !== undefined && count > 1 ? `${count} processes hold ${P.daemonSock}; duplicate daemons can lose messages` : `running for ${ROOT}${count === undefined ? "; duplicate check unavailable" : ""}`
    ]);
  }
  {
    const pending = codexHooksNeedingTrust();
    if (pending.length)
      rows.push([
        "codex hooks",
        false,
        `${pending.join(", ")} not trusted yet, so codex will skip them. Run codex, then /hooks, and trust the crosstalk entries.`
      ]);
  }
  {
    const lost = lostSessions(ctxNow(), process.env.CLAUDE_CODE_SESSION_ID);
    rows.push([
      "restore",
      lost.length ? false : null,
      lost.length ? `${lost.length} session(s) lost to a restart (${names(lost)}). Say "restore them", or run crosstalk restore --yes` : "nothing to restore"
    ]);
    if (process.platform === "darwin") {
      const app = appName(captureTerminal(process.env, process.pid, false));
      const ax = accessibilityGranted();
      const [axSteps, axCmd] = permissionSteps("accessibility", app);
      rows.push([
        "accessibility",
        ax,
        ax === true ? `${app} may open tabs` : `${ax === false ? "off" : "unknown"}; without it restored sessions open as one window each.
${" ".repeat(26)}${axSteps}
${" ".repeat(26)}${axCmd}`
      ]);
      const au = automationGranted();
      const [auSteps, auCmd] = permissionSteps("automation", app);
      rows.push([
        "automation",
        au === "yes" ? true : au === "no" ? false : null,
        au === "yes" ? `${app} may control System Events` : au === "ask" ? `macOS will ask once, the first time sessions are restored as tabs; allow it` : `${au === "no" ? "off" : "unknown"}; tabs need ${app} to control System Events.
${" ".repeat(26)}${auSteps}
${" ".repeat(26)}${auCmd}`
      ]);
    }
  }
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
        on ? "on, which can silently drop the other machine's connection. Allow incoming for bun or node, or turn it off while the two of you connect." : "off, incoming connections are not blocked"
      ]);
    }
  }
  if (daemonRunning()) {
    try {
      const s = await request({ op: "status" });
      rows.push(["daemon \u2194 relay", s.relay === "connected", s.relay]);
      rows.push(["registered sessions", s.sessions.length > 0, s.sessions.map((x) => x.name).join(", ") || "none"]);
    } catch (e) {
      rows.push(["daemon \u2194 relay", false, e.message]);
    }
  }
  heading();
  for (const [name, ok, detail] of rows) {
    console.log(`  ${ok === null ? "\xB7" : ok ? "\u2713" : "\u2717"}  ${name.padEnd(20)} ${detail}`);
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
      process.kill(Number(fs12.readFileSync(P.daemonLock, "utf8")), "SIGTERM");
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
  const [verb, ...rest] = positional;
  if (verb === "new")
    return startRoom("");
  if (verb === "join") {
    const words = rest.join(" ").trim();
    if (!words)
      die("usage: crosstalk room join <the four words you were read>");
    return startRoom(words);
  }
  await ready();
  if (!verb || verb === "list") {
    const r = await request({ op: "rooms" });
    const direct = r.direct ?? [];
    if (!r.rooms.length && !direct.length) {
      console.log(`
You are not in anything yet.

  /crosstalk:room new             start one, and read the words to someone
  /crosstalk:room join <words>    join one you were read
  /crosstalk:room create platform  one for a whole team, any size
`);
      return;
    }
    console.log();
    if (direct.length) {
      for (const room of direct)
        console.log(`  ${room.name.padEnd(16)}just the two of you`);
    }
    for (const room of r.rooms) {
      const who = room.members.map((m) => m.label + (m.you ? " (you)" : "") + (m.state === "invited" ? " (invited)" : "") + (!m.direct && !m.you ? " \xB7no direct channel" : "")).join(", ");
      if (room.pending) {
        console.log(`  #${room.name}   INVITATION from ${room.pending.invitedBy}`);
        console.log(`      ${who}`);
        console.log(`      accept:  /crosstalk:room accept ${room.name}`);
      } else {
        console.log(`  #${room.name}`.padEnd(18) + who);
      }
    }
    console.log();
    return;
  }
  const say = (r, ok) => r.ok ? console.log(ok) : die(r.error);
  switch (verb) {
    case "create": {
      const name = rest[0] ?? die("name the room: /crosstalk:room create platform");
      const r = await request({ op: "room_create", name });
      say(r, `created #${r.room}. Invite someone you already share a room with:

  /crosstalk:room invite ${r.room} <peer>
`);
      return;
    }
    case "invite": {
      const [name, ...people] = rest;
      if (!name || !people.length)
        die("usage: /crosstalk:room invite platform marie jo");
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
      const name = rest[0] ?? die(`usage: /crosstalk:room ${verb} platform`);
      const r = await request({ op: `room_${verb}`, room: name });
      say(r, verb === "accept" ? `joined #${r.room}` : `left #${r.room}`);
      return;
    }
    case "kick":
    case "remove": {
      const [name, who] = rest;
      if (!name || !who)
        die("usage: /crosstalk:room kick platform marie");
      const r = await request({ op: "room_kick", room: name, peer: who });
      if (!r.ok)
        die(r.error);
      console.log(`removed ${r.removed} from #${name} and rekeyed to epoch ${r.rekeyedTo}`);
      if (r.unreachable?.length)
        console.log(`
Could not hand the new key to: ${r.unreachable.join(", ")}.
You have no direct channel to them, so someone who has must pass it on.`);
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
(after which you would have to start every room again)`);
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
    console.log("People already in a room with you keep the name they gave you.");
    if (daemonRunning())
      console.log("Restart the daemon to advertise it: /crosstalk:status then crosstalk daemon restart");
    return;
  }
  if (!a || !b) {
    const peers = loadPeers();
    console.log(`
usage: /crosstalk:rename <current> <new>
       /crosstalk:rename me <new>
`);
    console.log(`known: ${Object.keys(peers).join(", ") || "nobody yet"}
`);
    return;
  }
  const peers = loadPeers();
  const peer = peers[a];
  if (!peer)
    die(`no peer called "${a}". Known: ${Object.keys(peers).join(", ") || "nobody"}`);
  if (peers[b])
    die(`"${b}" is already someone else (${peers[b].fingerprint})`);
  delete peers[a];
  peers[b] = { ...peer, label: b };
  savePeers(peers);
  const t = load2();
  if (t.people[a]) {
    t.people[b] = t.people[a];
    delete t.people[a];
  }
  if (t.muted[a]) {
    t.muted[b] = t.muted[a];
    delete t.muted[a];
  }
  save(t);
  try {
    const uPath = path13.join(ROOT, "usage.json");
    const u = JSON.parse(fs12.readFileSync(uPath, "utf8"));
    if (u[a]) {
      u[b] = u[a];
      delete u[a];
      fs12.writeFileSync(uPath, JSON.stringify(u, null, 2), { mode: 384 });
    }
  } catch {}
  try {
    const qPath = path13.join(ROOT, "queue.json");
    const q = JSON.parse(fs12.readFileSync(qPath, "utf8"));
    let touched = 0;
    for (const msgs of Object.values(q))
      for (const m of msgs)
        if (m.from === a)
          m.from = b, touched++;
    if (touched)
      fs12.writeFileSync(qPath, JSON.stringify(q, null, 2), { mode: 384 });
  } catch {}
  console.log(`"${a}" is "${b}" now, still ${peer.fingerprint}.`);
  if (daemonRunning())
    console.log("Restart the daemon so it picks this up: crosstalk daemon restart");
}
async function trustCmd() {
  const t = load2();
  const level = positional.find((a) => isLevel(a));
  const who = positional.find((a) => a !== level);
  const room = flag("--in");
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
    return console.log(`anyone in a room with you, by default: ${level}`);
  }
  const isPerson = !!loadPeers()[who];
  if (room) {
    t.people[who] = level;
    t.rooms[room] = t.rooms[room] ?? ROOM_DEFAULT;
    save(t);
    return console.log(`${who} is "${level}" (pinned, so it applies in #${room} too)`);
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
async function post() {
  const text = positional.join(" ").trim() || flag("--text", "");
  if (!text)
    die('usage: crosstalk post "build failed on main" [--intent blocking] [--source ci]');
  refuseIfIdentityDamaged();
  identityOrCreate();
  if (!await ensureDaemon(ROOT_DIR))
    die("the daemon would not start. See ~/.claude/crosstalk/daemon.log");
  const r = await request({
    op: "post",
    text,
    intent: flag("--intent", "fyi"),
    source: flag("--source", "local")
  });
  console.log(r.ok ? `posted as ${r.source}` : `not posted: ${r.error}`);
}
async function attention() {
  await ready();
  const r = await request({ op: "attention" });
  heading();
  console.log(`  reached you  ${r.used} in the last hour`);
  console.log(`  held         ${r.held} waiting for you to go idle`);
  const rows = Object.entries(r.bySource ?? {});
  if (rows.length) {
    console.log();
    const most = Math.max(...rows.map(([, n]) => n));
    for (const [who, n] of rows.sort((a, b) => b[1] - a[1]))
      console.log(`  ${who.padEnd(14)}${String(n).padStart(3)}  ${"\u25CF".repeat(Math.ceil(n / most * 10))}`);
  }
  console.log(`
  Nothing here is capped. This is a record of who has been reaching you, so
  that if someone is reaching you too often you can say so, per person, with
  /crosstalk:trust.
`);
}
async function tasksCmd() {
  await ready();
  const verb = positional[0];
  if (verb === "add") {
    const r = await request({
      op: "tasks",
      write: "add",
      text: positional.slice(1).join(" "),
      for: flag("--for")
    });
    return console.log(r.ok ? `added ${r.id} to #${r.room}` : `not added: ${r.error}`);
  }
  if (verb === "claim" || verb === "done" || verb === "release" || verb === "drop") {
    const r = await request({
      op: "tasks",
      write: verb,
      id: positional[1],
      note: positional.slice(2).join(" ") || undefined
    });
    return console.log(r.ok ? `${verb}: ${positional[1]}` : r.error ?? "nothing changed");
  }
  const r = await request({ op: "tasks" });
  const all = Object.entries(r.tasks ?? {});
  if (!all.some(([, t]) => t.length)) {
    console.log(`
  Nothing on the list.

    /crosstalk:tasks add "wire the upload retry" --for marie
`);
    return;
  }
  for (const [room, list] of all) {
    if (!list.length)
      continue;
    console.log(`
  #${room}`);
    for (const t of list) {
      const who = t.state === "claimed" ? `claimed by ${t.claimedBy}` : t.for ? `for ${t.for}` : "open";
      console.log(`    ${t.id}  ${t.text}`);
      console.log(`${" ".repeat(12)}${who}, from ${t.by}`);
    }
  }
  console.log();
}
async function factsCmd() {
  await ready();
  const verb = positional[0];
  if (verb === "add" || verb === "remember") {
    const text = positional.slice(1).join(" ");
    const r = await request({ op: "facts", write: "add", text, tags: (flag("--in") ?? "").split(",").filter(Boolean) });
    return console.log(r.ok ? `remembered in #${r.room}` : `not saved: ${r.error}`);
  }
  if (verb === "confirm" || verb === "correct" || verb === "forget") {
    const map = { confirm: "confirm", correct: "supersede", forget: "remove" };
    const r = await request({
      op: "facts",
      write: map[verb],
      id: positional[1],
      text: positional.slice(2).join(" ") || undefined,
      reason: flag("--because")
    });
    return console.log(r.ok ? `${verb}ed ${positional[1]}` : `nothing changed: ${r.error ?? "no such fact"}`);
  }
  const r = await request({ op: "facts", cwd: process.cwd() });
  const all = Object.entries(r.facts ?? {});
  const any = all.some(([, f]) => f.length);
  if (!any) {
    console.log(`
  Nothing written down yet.

    /crosstalk:facts add "the API returns snake_case"
    /crosstalk:facts add "uploads chunk at 4KB" --in palpable-fw
`);
    return;
  }
  for (const [room, list] of all) {
    if (!list.length)
      continue;
    console.log(`
  #${room}`);
    for (const f of list) {
      const who = [f.by, ...f.confirmed.map((x) => x.by)];
      console.log(`    ${f.id}  ${f.text}`);
      console.log(`${" ".repeat(12)}${who.join(", ")}${f.tags.length ? "  in " + f.tags.join(", ") : ""}`);
    }
  }
  console.log();
}
async function link() {
  const zlib = await import("zlib");
  const id = loadIdentity();
  const joining = positional.join(" ").trim();
  if (joining) {
    if (id)
      die(`this machine already has an identity ("${id.label}"). Linking would replace it,
along with every room it is in. Move ~/.claude/crosstalk aside first if
you are sure.`);
    const inv = parseInvite(joining);
    if (inv.where) {
      for (const candidate of expandAddress(inv.where, inv.port ?? 8787))
        if (await relayReachable(candidate, 3000)) {
          saveRelay(candidate);
          break;
        }
    }
    if (!inv.slot)
      die("that link is missing its number. It looks like 4821-six-words-like-this.");
    const first = await fetch(`${httpBase()}/invite/${inv.slot}?part=a`);
    if (!first.ok)
      die("no link waiting on that number. They last fifteen minutes.");
    const theirPoint = (await first.json()).blob;
    const half = begin(inv.phrase, inv.slot);
    const key = finish(half, theirPoint, inv.slot, "crosstalk/link/v1");
    if (!key)
      die("could not use that link. Check the words.");
    await fetch(`${httpBase()}/invite/${inv.slot}?part=b`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blob: half.message })
    });
    let bundle;
    for (let i = 0;i < 120; i++) {
      const r = await fetch(`${httpBase()}/invite/${inv.slot}?part=c`).catch(() => null);
      if (r?.ok) {
        try {
          const raw = JSON.parse(open(key, (await r.json()).blob));
          bundle = JSON.parse(zlib.gunzipSync(Buffer.from(raw.z, "base64")).toString("utf8"));
        } catch {
          return die("could not read what came back. Start again.");
        }
        break;
      }
      await new Promise((res) => setTimeout(res, 1000));
    }
    if (!bundle)
      die("the other machine never sent anything. Start again.");
    fs12.mkdirSync(ROOT, { recursive: true, mode: 448 });
    const write = (name, value) => fs12.writeFileSync(path13.join(ROOT, name), JSON.stringify(value, null, 2), { mode: 384 });
    write("identity.json", { ...bundle.identity, machine: machineName() });
    write("peers.json", bundle.peers ?? {});
    if (bundle.rooms)
      write("rooms.json", bundle.rooms);
    if (bundle.trust)
      write("trust.json", bundle.trust);
    if (bundle.relay)
      write("relay.json", bundle.relay);
    await ensureDaemon(ROOT_DIR);
    console.log(`
This machine is now "${bundle.identity.label}", the same one as your other machine.

  ${fingerprint(bundle.identity.ed.pub)}

Every room came across. In one you appear once, not twice,
and a message reaches whichever machine you are sitting at.`);
    return;
  }
  if (!id)
    die("nothing to link yet. Run /crosstalk:room new first, or run this on the machine that already has your identity.");
  const url0 = loadRelay().url;
  const slotRes = await fetch(`${httpBase(url0)}/slot`, { method: "POST" }).catch(() => null);
  if (!slotRes?.ok)
    die("the relay would not give out a slot. Try again in a moment.");
  const { slot } = await slotRes.json();
  const phrase = newPhrase(6);
  const half = begin(phrase, slot);
  const bundle = {
    identity: id,
    peers: loadPeers(),
    rooms: (() => {
      try {
        return JSON.parse(fs12.readFileSync(path13.join(ROOT, "rooms.json"), "utf8"));
      } catch {
        return {};
      }
    })(),
    trust: load2(),
    relay: loadRelay()
  };
  const z = zlib.gzipSync(Buffer.from(JSON.stringify(bundle), "utf8")).toString("base64");
  const url = url0;
  await fetch(`${httpBase(url)}/invite/${slot}?part=a`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ blob: half.message })
  });
  console.log(`
On your other machine, run:

    /crosstalk:link ${slot}-${phrase}

Waiting\u2026`);
  let key = null;
  for (let i = 0;i < 900; i++) {
    const r = await fetch(`${httpBase(url)}/invite/${slot}?part=b`).catch(() => null);
    if (r?.ok) {
      key = finish(half, (await r.json()).blob, slot, "crosstalk/link/v1");
      break;
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  if (!key)
    die("the other machine never answered.");
  const sealed = seal(key, JSON.stringify({ z }));
  if (sealed.length > 8000)
    die("too much to send in one go. This happens with a lot of peers; copy ~/.claude/crosstalk across by hand instead.");
  const res = await fetch(`${httpBase(url)}/invite/${slot}?part=c`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ blob: sealed })
  });
  if (!res.ok)
    die("the relay would not take it. Try again in a minute.");
  console.log(`
That machine is becoming this identity: same fingerprint, same people, same
rooms. Those six words carry your whole identity, so keep them between your own
two machines and nowhere else.`);
}
async function installAgy() {
  const root = rootFrom2(import.meta.url);
  const bin = shim2(root);
  const dir = path13.join(os8.homedir(), ".gemini", "config");
  const file = path13.join(dir, "hooks.json");
  fs12.mkdirSync(dir, { recursive: true });
  let all = {};
  if (fs12.existsSync(file)) {
    try {
      all = JSON.parse(fs12.readFileSync(file, "utf8"));
    } catch {
      die(`${file} is not valid JSON. Fix or move it, then run this again.`);
    }
  }
  all.crosstalk = {
    PreInvocation: [
      { type: "command", command: `"${bin}" hook PreInvocation`, timeout: 20 }
    ]
  };
  fs12.writeFileSync(file, JSON.stringify(all, null, 2) + `
`);
  console.log(`hooks    ${file}`);
  try {
    execFileSync4("agy", ["mcp", "add", "crosstalk", bin, "server"], { stdio: "pipe" });
    console.log(`tools    registered with agy as "crosstalk"`);
  } catch (e) {
    const why = String(e?.stderr ?? e?.message ?? "").trim().split(`
`)[0];
    console.log(`tools    not registered${why ? `: ${why}` : ""}`);
    console.log(`         run: agy mcp add crosstalk ${bin} server`);
  }
  console.log(`
agy has no session-start event, so a session announces itself on its first
model call rather than at launch. Start a new agy session, or send one prompt
in an existing one, and it will show up in \`crosstalk peers\`.

agy also runs a hook in the directory holding hooks.json, so it learns which
project a session is in from the workspace rather than the working directory.
If \`crosstalk facts\` looks unscoped, launch agy with --add-dir "$PWD".`);
}
async function installQwen() {
  const bin = shim2(rootFrom2(import.meta.url));
  const dir = path13.join(os8.homedir(), ".qwen");
  const file = path13.join(dir, "settings.json");
  fs12.mkdirSync(dir, { recursive: true });
  let cfg = {};
  if (fs12.existsSync(file)) {
    try {
      cfg = JSON.parse(fs12.readFileSync(file, "utf8"));
    } catch {
      die(`${file} is not valid JSON. Fix or move it, then run this again.`);
    }
  }
  const entry = { hooks: [{ type: "command", command: `"${bin}" hook`, timeout: 20000 }] };
  cfg.hooks ??= {};
  for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]) {
    const others = (cfg.hooks[event] ?? []).filter((g) => !JSON.stringify(g).includes("crosstalk"));
    cfg.hooks[event] = [...others, entry];
  }
  fs12.writeFileSync(file, JSON.stringify(cfg, null, 2) + `
`);
  console.log(`hooks    ${file}`);
  registerMcp("qwen", ["mcp", "add", "crosstalk", bin, "server"], bin);
}
async function installKimi() {
  const bin = shim2(rootFrom2(import.meta.url));
  const dir = path13.join(os8.homedir(), ".kimi-code");
  const file = path13.join(dir, "config.toml");
  fs12.mkdirSync(dir, { recursive: true });
  const existing = fs12.existsSync(file) ? fs12.readFileSync(file, "utf8") : "";
  const kept = existing.replace(/\n*# crosstalk\n(?:\[\[hooks\]\][^[]*)+/g, `
`);
  const blocks = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"].map((event) => `[[hooks]]
event = "${event}"
command = "${bin} hook --client kimi"
timeout = 20
`).join(`
`);
  fs12.writeFileSync(file, `${kept.trimEnd()}

# crosstalk
${blocks}`);
  console.log(`hooks    ${file}`);
  console.log(`tools    add the MCP server in ${path13.join(dir, "mcp.json")}`);
}
async function installHermes() {
  const bin = shim2(rootFrom2(import.meta.url));
  const dir = path13.join(os8.homedir(), ".hermes");
  const file = path13.join(dir, "config.yaml");
  if (!fs12.existsSync(file))
    die(`no ${file}. Run hermes once first, then run this again.`);
  const existing = fs12.readFileSync(file, "utf8");
  if (existing.includes("crosstalk hook"))
    die(`${file} already has crosstalk hooks. Remove them by hand to reinstall.`);
  if (/^hooks:/m.test(existing))
    die(`${file} already has a hooks: block. Add these two entries to it by hand:

hooks:
  on_session_start:
    - command: "${bin} hook on_session_start"
      timeout: 20
  pre_llm_call:
    - command: "${bin} hook pre_llm_call"
      timeout: 20`);
  fs12.writeFileSync(file, `${existing.trimEnd()}

# crosstalk
hooks:
  on_session_start:
    - command: "${bin} hook on_session_start"
      timeout: 20
  pre_llm_call:
    - command: "${bin} hook pre_llm_call"
      timeout: 20
`);
  console.log(`hooks    ${file}`);
  console.log(`
Hermes asks before it will run a hook it has not seen. Start it once in a
terminal and answer yes twice, or run it with --accept-hooks. Check with:

  hermes hooks list`);
}
async function installGoose() {
  const bin = shim2(rootFrom2(import.meta.url));
  const dir = path13.join(os8.homedir(), ".agents", "plugins", "crosstalk");
  fs12.mkdirSync(path13.join(dir, "hooks"), { recursive: true });
  fs12.writeFileSync(path13.join(dir, "plugin.json"), JSON.stringify({
    name: "crosstalk",
    version: "0.1.0",
    description: "Messages from other people's coding agents, delivered into this session."
  }, null, 2) + `
`);
  const group = (command) => ({ hooks: [{ type: "command", command }] });
  fs12.writeFileSync(path13.join(dir, "hooks", "hooks.json"), JSON.stringify({ hooks: { SessionStart: [group(`"${bin}" hook`)], Stop: [group(`"${bin}" hook`)] } }, null, 2) + `
`);
  console.log(`hooks    ${path13.join(dir, "hooks", "hooks.json")}`);
  const gooseConf = path13.join(os8.homedir(), ".config", "goose", "config.yaml");
  const entry = [
    `  crosstalk:`,
    `    enabled: true`,
    `    type: stdio`,
    `    name: crosstalk`,
    `    description: Messages from other people's coding agents`,
    `    cmd: ${bin}`,
    `    args: [server]`,
    `    timeout: 300`
  ].join(`
`);
  let conf = "";
  try {
    conf = fs12.readFileSync(gooseConf, "utf8");
  } catch {}
  if (conf.includes(`cmd: ${bin}`)) {
    console.log(`tools    already in ${gooseConf}`);
  } else if (/^extensions:\n/m.test(conf)) {
    fs12.writeFileSync(gooseConf, conf.replace(/^extensions:\n/m, `extensions:
${entry}
`));
    console.log(`tools    ${gooseConf}`);
  } else if (/^extensions:/m.test(conf)) {
    console.log(`tools    add this under extensions: in ${gooseConf}

${entry}
`);
  } else {
    fs12.mkdirSync(path13.dirname(gooseConf), { recursive: true });
    fs12.writeFileSync(gooseConf, `${conf.trimEnd()}

extensions:
${entry}
`);
    console.log(`tools    ${gooseConf}`);
  }
  console.log(`
Goose has no way to add text to a turn, so a message arrives when the agent
tries to finish one: the hook refuses the stop and hands over the notice. That
means it is heard between turns rather than during one, and it gets no working
set of facts on start.`);
}
async function installCursor() {
  const bin = shim2(rootFrom2(import.meta.url));
  const dir = path13.join(os8.homedir(), ".cursor");
  const file = path13.join(dir, "hooks.json");
  fs12.mkdirSync(dir, { recursive: true });
  let cfg = { version: 1, hooks: {} };
  if (fs12.existsSync(file)) {
    try {
      cfg = JSON.parse(fs12.readFileSync(file, "utf8"));
    } catch {
      die(`${file} is not valid JSON. Fix or move it, then run this again.`);
    }
  }
  cfg.version ??= 1;
  cfg.hooks ??= {};
  for (const step of ["sessionStart", "beforeSubmitPrompt", "postToolUse"]) {
    const others = (cfg.hooks[step] ?? []).filter((h) => !String(h?.command ?? "").includes("crosstalk"));
    cfg.hooks[step] = [...others, { type: "command", command: `"${bin}" hook` }];
  }
  fs12.writeFileSync(file, JSON.stringify(cfg, null, 2) + `
`);
  console.log(`hooks    ${file}`);
  console.log(`tools    add the MCP server in ${path13.join(dir, "mcp.json")}`);
  console.log(`
Cursor drops any injected text over 10,000 characters rather than shortening
it, so crosstalk trims to fit and says so where it cut.`);
}
var CODEX_EVENT_KEY = {
  SessionStart: "session_start",
  UserPromptSubmit: "user_prompt_submit",
  PreToolUse: "pre_tool_use",
  PostToolUse: "post_tool_use",
  Stop: "stop"
};
function codexHooksNeedingTrust() {
  const file = path13.join(os8.homedir(), ".codex", "hooks.json");
  const conf = path13.join(os8.homedir(), ".codex", "config.toml");
  if (!fs12.existsSync(file))
    return [];
  let hooks;
  try {
    hooks = JSON.parse(fs12.readFileSync(file, "utf8")).hooks ?? {};
  } catch {
    return [];
  }
  let toml = "";
  try {
    toml = fs12.readFileSync(conf, "utf8");
  } catch {}
  const untrusted = [];
  for (const [event, groups] of Object.entries(hooks)) {
    const key = CODEX_EVENT_KEY[event];
    if (!key || !Array.isArray(groups))
      continue;
    groups.forEach((group, g) => {
      const handlers = Array.isArray(group?.hooks) ? group.hooks : [group];
      handlers.forEach((h, i) => {
        if (!String(h?.command ?? "").includes("crosstalk"))
          return;
        if (!toml.includes(`${file}:${key}:${g}:${i}`))
          untrusted.push(event);
      });
    });
  }
  return untrusted;
}
async function installCodex() {
  const bin = shim2(rootFrom2(import.meta.url));
  const dir = path13.join(os8.homedir(), ".codex");
  const file = path13.join(dir, "hooks.json");
  fs12.mkdirSync(dir, { recursive: true });
  let cfg = {};
  if (fs12.existsSync(file)) {
    try {
      cfg = JSON.parse(fs12.readFileSync(file, "utf8"));
    } catch {
      die(`${file} is not valid JSON. Fix or move it, then run this again.`);
    }
  }
  cfg.hooks ??= {};
  for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]) {
    const others = (cfg.hooks[event] ?? []).filter((g) => !JSON.stringify(g).includes("crosstalk"));
    cfg.hooks[event] = [...others, { hooks: [{ type: "command", command: `"${bin}" hook` }] }];
  }
  fs12.writeFileSync(file, JSON.stringify(cfg, null, 2) + `
`);
  console.log(`hooks    ${file}`);
  console.log(`
Codex will not run a hook until you say so, and says nothing when it skips one.
Start codex, run /hooks, and trust the crosstalk entries. Check it took with:

  crosstalk doctor`);
}
function registerMcp(cli, args, bin) {
  try {
    execFileSync4(cli, args, { stdio: "pipe" });
    console.log(`tools    registered with ${cli} as "crosstalk"`);
  } catch (e) {
    const why = String(e?.stderr ?? e?.message ?? "").trim().split(`
`)[0];
    console.log(`tools    not registered${why ? `: ${why}` : ""}`);
    console.log(`         run: ${cli} ${args.join(" ")}`);
  }
}
async function installPath() {
  const bin = shim2(rootFrom2(import.meta.url));
  const dir = path13.join(os8.homedir(), ".local", "bin");
  const link = path13.join(dir, "crosstalk");
  fs12.mkdirSync(dir, { recursive: true });
  let existing = "";
  try {
    existing = fs12.readlinkSync(link);
  } catch {
    if (fs12.existsSync(link))
      die(`${link} already exists and is not a link. Move it, then run this again.`);
  }
  if (existing && existing !== bin)
    console.log(`replacing a link to ${existing}`);
  try {
    fs12.unlinkSync(link);
  } catch {}
  fs12.symlinkSync(bin, link);
  console.log(`linked   ${link} -> ${bin}`);
  const onPath = (process.env.PATH ?? "").split(":").includes(dir);
  console.log(onPath ? `
\`crosstalk\` now works anywhere, including from a build script.` : `
${dir} is not on your PATH. Add this to your shell profile:

  export PATH="$HOME/.local/bin:$PATH"`);
}
async function restoreCmd() {
  const self = process.env.CLAUDE_CODE_SESSION_ID || undefined;
  if (has("--finish")) {
    await finishWhenPermitted();
    return;
  }
  if (positional[0] === "no")
    return console.log(forget(self).text);
  if (has("--yes") || has("-y") || positional[0] === "yes") {
    const out = restore({ self, tabs: !has("--windows"), userAction: true, root: ROOT_DIR });
    console.log(out.text);
    if (!out.ok)
      process.exit(1);
    return;
  }
  const d = describe(self, process.env, has("--dry-run"));
  console.log(d.text);
  if (d.lost.length && !has("--dry-run"))
    console.log(`
  crosstalk restore --yes     reopen them
  crosstalk restore --dry-run show exactly what would run`);
}
async function gatherCmd() {
  const self = process.env.CLAUDE_CODE_SESSION_ID || undefined;
  if (has("--finish"))
    return void console.log(await finish2());
  if (has("--yes") || has("-y") || positional[0] === "yes")
    return void console.log(start({ self, root: ROOT_DIR }).text);
  const d = describe2(self);
  console.log(d.text);
  if (d.sessions.length)
    console.log(`
  crosstalk gather --yes   bring them in`);
}
async function install() {
  const who = (positional[0] ?? "").toLowerCase();
  if (who === "agy" || who === "antigravity")
    return installAgy();
  if (who === "qwen")
    return installQwen();
  if (who === "kimi")
    return installKimi();
  if (who === "hermes")
    return installHermes();
  if (who === "goose")
    return installGoose();
  if (who === "cursor" || who === "cursor-agent")
    return installCursor();
  if (who === "codex")
    return installCodex();
  if (who === "path")
    return installPath();
  die(`usage: crosstalk install <codex|cursor|agy|qwen|kimi|hermes|goose|path>

  path   put \`crosstalk\` on your PATH, for build scripts and anything
         that is not a coding agent

Claude Code and Codex install as a plugin instead:
  /plugin marketplace add epode-studio/crosstalk
  /plugin install crosstalk@epode`);
}
var commands = {
  link,
  post,
  attention,
  facts: factsCmd,
  tasks: tasksCmd,
  rename,
  trust: trustCmd,
  room,
  secure,
  peers,
  mute,
  cost,
  status,
  doctor,
  daemon,
  relay,
  install,
  restore: restoreCmd,
  gather: gatherCmd,
  ui: () => uiCmd(argv, ROOT_DIR)
};
await (commands[cmd] ?? (async () => die(`unknown command "${cmd}"`)))();
