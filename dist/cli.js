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
var newPhrase = (words = 5) => Array.from({ length: words }, () => WORDS[crypto.randomInt(WORDS.length)]).join("-");
var SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
var asPeer = (o) => ({
  label: o.label,
  machine: o.machine,
  isMachine: o.isMachine,
  edPub: o.edPub,
  xPub: o.xPub,
  fingerprint: fingerprint(o.edPub),
  pairedAt: Date.now()
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
    let p2 = _1n2;
    while (power > _0n2) {
      if (power & _1n2)
        p2 = p2 * d % modulo;
      d = d * d % modulo;
      power >>= _1n2;
    }
    return p2;
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
function sqrt9mod16(P2) {
  const Fp_ = Field(P2);
  const tn = tonelliShanks(P2);
  const c1 = tn(Fp_, Fp_.neg(Fp_.ONE));
  const c2 = tn(Fp_, c1);
  const c3 = tn(Fp_, Fp_.neg(c1));
  const c4 = (P2 + _7n) / _16n;
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
function tonelliShanks(P2) {
  if (P2 < _3n)
    throw new Error("sqrt is not defined for small field");
  aoddModulus(P2, "tonelliShanks");
  let Q = P2 - _1n2;
  let S = 0;
  while (Q % _2n === _0n2) {
    Q /= _2n;
    S++;
  }
  let Z = _2n;
  const _Fp = Field(P2);
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
function FpSqrt(P2) {
  aoddModulus(P2, "Fp.sqrt");
  if (P2 % _4n === _3n)
    return sqrt3mod4;
  if (P2 % _8n === _5n)
    return sqrt5mod8;
  if (P2 % _16n === _9n)
    return sqrt9mod16(P2);
  return tonelliShanks(P2);
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
function probeRandomBytes(randomBytes3, length) {
  if (randomBytes3 === undefined)
    return;
  afunction(randomBytes3, "randomBytes");
  try {
    const probe = randomBytes3(length);
    if (!isBytes2(probe) || probe.length !== length)
      return;
  } catch {
    return;
  }
  return randomBytes3;
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
function getWindowSize(P2) {
  return pointWindowSizes.get(P2) || 1;
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
  constructor(Point, randomBytes3) {
    validatePointCons(Point);
    this.randomBytes = probeRandomBytes(randomBytes3, BLIND_BYTES);
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
  const randomBytes3 = opts.randomBytes === undefined ? randomBytes2 : opts.randomBytes;
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
  const wnaf = new ScalarMultiplier(Point, randomBytes3);
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
  const P2 = ed25519_CURVE_p;
  const x2 = x * x % P2;
  const b2 = x2 * x % P2;
  const b4 = pow2(b2, _2n3, P2) * b2 % P2;
  const b5 = pow2(b4, _1n5, P2) * x % P2;
  const b10 = pow2(b5, _5n2, P2) * b5 % P2;
  const b20 = pow2(b10, _10n, P2) * b10 % P2;
  const b40 = pow2(b20, _20n, P2) * b20 % P2;
  const b80 = pow2(b40, _40n, P2) * b40 % P2;
  const b160 = pow2(b80, _80n, P2) * b80 % P2;
  const b240 = pow2(b160, _80n, P2) * b80 % P2;
  const b250 = pow2(b240, _10n, P2) * b10 % P2;
  const pow_p_5_8 = pow2(b250, _2n3, P2) * x % P2;
  return { pow_p_5_8, b2 };
}
var ED25519_SQRT_M1 = /* @__PURE__ */ BigInt("19681161376707505956807079304988542015446066515923890162744021073123829784752");
function uvRatio(u, v) {
  const P2 = ed25519_CURVE_p;
  const v3 = mod(v * v * v, P2);
  const v7 = mod(v3 * v3 * v, P2);
  const pow3 = ed25519_pow_2_252_3(u * v7).pow_p_5_8;
  let x = mod(u * v3 * pow3, P2);
  const vx2 = mod(v * x * x, P2);
  const root1 = x;
  const root2 = mod(x * ED25519_SQRT_M1, P2);
  const useRoot1 = vx2 === u;
  const useRoot2 = vx2 === mod(-u, P2);
  const noRoot = vx2 === mod(-u * ED25519_SQRT_M1, P2);
  if (useRoot1)
    x = root1;
  if (useRoot2 || noRoot)
    x = root2;
  if (isNegativeLE(x, P2))
    x = mod(-x, P2);
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
    throw new Error(`"${input}" does not look like a pairing phrase (expected four words)`);
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
  const clean2 = (s) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);
  if (process.platform === "darwin") {
    try {
      const name = execFileSync2("scutil", ["--get", "ComputerName"], {
        encoding: "utf8",
        timeout: 2000
      });
      const c = clean2(name).replace(/^[a-z]+-?s-/, "");
      if (c)
        return c;
    } catch {}
  }
  return clean2(os2.hostname().split(".")[0]) || "machine";
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
  const add2 = (u) => {
    if (u && !out.includes(u))
      out.push(u);
  };
  if (/^https?:\/\//i.test(t)) {
    add2(t.replace(/^http/, "ws").replace(/\/$/, ""));
    return out;
  }
  if (/\./.test(t) && /[a-z]/i.test(t)) {
    add2(t.endsWith("trycloudflare.com") ? `wss://${t}` : `ws://${t}:${port}`);
    return out;
  }
  if (/^[a-z0-9][a-z0-9-]*$/i.test(t) && !/^\d+$/.test(t)) {
    add2(`ws://${t}:${port}`);
    add2(`ws://${t}.local:${port}`);
    add2(`wss://${t}.trycloudflare.com`);
    return out;
  }
  const mine = bestAddress().host;
  const parts = mine.split(".");
  if (/^\d{1,3}$/.test(t) && parts.length === 4)
    add2(`ws://${parts[0]}.${parts[1]}.${parts[2]}.${t}:${port}`);
  if (/^\d{1,3}\.\d{1,3}$/.test(t) && parts.length === 4)
    add2(`ws://${parts[0]}.${parts[1]}.${t}:${port}`);
  add2(`ws://${t}:${port}`);
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
import os5 from "os";
import { spawn as spawn3, execFileSync as execFileSync4 } from "child_process";
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
async function pair() {
  if (has("--relay"))
    saveRelay(flag("--relay"));
  const id = identityOrCreate();
  const joining = positional.join(" ").trim();
  const base = () => httpBase(loadRelay().url);
  const put = async (slot2, part, blob) => {
    const r = await fetch(`${base()}/pair/${slot2}?part=${part}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blob })
    });
    if (!r.ok)
      die(`the relay would not take part ${part} (${r.status})`);
  };
  const get = async (slot2, part, waitMs = 0) => {
    const deadline = Date.now() + waitMs;
    for (;; ) {
      const r = await fetch(`${base()}/pair/${slot2}?part=${part}`).catch(() => null);
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
    const theirs2 = await get(inv.slot, "a");
    if (!theirs2)
      die(`nothing is waiting on ${inv.slot}. Invites last fifteen minutes.`);
    const mine2 = begin(inv.phrase, inv.slot);
    const key2 = finish(mine2, theirs2, inv.slot, "crosstalk/pair/v4");
    if (!key2)
      die("that invite could not be used. Check the words.");
    await put(inv.slot, "b", mine2.message + "." + seal(key2, JSON.stringify(await myOffer(id))));
    const back = await get(inv.slot, "c", 120000);
    if (!back)
      die("the other side never answered. Ask them to start again.");
    let peer2;
    try {
      peer2 = asPeer(JSON.parse(open(key2, back)));
    } catch {
      return die("could not read what they sent. Somebody may be interfering; start again.");
    }
    const localName = adoptPeer(peer2);
    peer2.label = localName;
    if (peer2.relayPub)
      saveRelay(loadRelay().url, peer2.relayPub);
    await ensureDaemon(ROOT_DIR);
    console.log(`
Paired with "${peer2.label}"${peer2.isMachine ? ", a machine rather than a person" : ""}.

  them  ${peer2.fingerprint}
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

They run  /crosstalk:pair ${invite}

Say it out loud, or send it somewhere you already trust. The number is public;
the words are the secret. They work once and expire in fifteen minutes.

  you       ${id.label}  ${fingerprint(id.ed.pub)}
  reaches   ${where ? "same network" : "anywhere"}

Waiting\u2026`);
  const theirs = await get(slot, "b", 900000);
  if (!theirs)
    die("that invite expired without anyone using it");
  const dot = theirs.indexOf(".");
  const key = finish(mine, theirs.slice(0, dot), slot, "crosstalk/pair/v4");
  if (!key)
    die("somebody tried to pair with the wrong words. Start again with a new invite.");
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
  await ensureDaemon(ROOT_DIR);
  console.log(`
Paired with "${peer.label}"${peer.isMachine ? ", a machine rather than a person" : ""}.

  them  ${peer.fingerprint}
  you   ${fingerprint(id.ed.pub)}

Read both to each other. If they match, nobody is in the middle.

They start at "ask": a line on your screen, and their agent may ask yours a
question. Nothing they do puts their words inside your turn.

  /crosstalk:trust`);
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
${p.online ? "\u25CF" : "\u25CB"} ${p.label}${p.isMachine ? " (a machine)" : ""}  ${p.fingerprint}  ${p.policy.delivery}${muted ? " (muted)" : ""}${p.unread ? `  ${p.unread} unread` : ""}`);
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
async function post() {
  const text = positional.join(" ").trim() || flag("--text", "");
  if (!text)
    die('usage: crosstalk post "build failed on main" [--intent blocking] [--source ci]');
  await ensureDaemon(ROOT_DIR);
  const r = await request({
    op: "post",
    text,
    intent: flag("--intent", "fyi"),
    source: flag("--source", "local")
  });
  console.log(r.ok ? `posted as ${r.source}` : `not posted: ${r.error}`);
}
async function attention() {
  await ensureDaemon(ROOT_DIR);
  const r = await request({ op: "attention" });
  console.log();
  console.log(`  budget       ${r.budget} an hour, ${r.used} used in the last hour`);
  console.log(`  held         ${r.held} waiting for you to go idle`);
  const rows = Object.entries(r.bySource ?? {});
  if (rows.length) {
    console.log();
    const most = Math.max(...rows.map(([, n]) => n));
    for (const [who, n] of rows.sort((a, b) => b[1] - a[1]))
      console.log(`  ${who.padEnd(14)}${String(n).padStart(3)}  ${"\u25CF".repeat(Math.ceil(n / most * 10))}`);
  }
  console.log(`
  A message held quietly costs nothing and is not counted. Only what actually
  reached you is. Change who may reach you with /crosstalk:trust.
`);
}
async function tasksCmd() {
  await ensureDaemon(ROOT_DIR);
  const verb = positional[0];
  if (verb === "add") {
    const r2 = await request({
      op: "tasks",
      write: "add",
      text: positional.slice(1).join(" "),
      for: flag("--for")
    });
    return console.log(r2.ok ? `added ${r2.id} to #${r2.room}` : `not added: ${r2.error}`);
  }
  if (verb === "claim" || verb === "done" || verb === "release" || verb === "drop") {
    const r2 = await request({
      op: "tasks",
      write: verb,
      id: positional[1],
      note: positional.slice(2).join(" ") || undefined
    });
    return console.log(r2.ok ? `${verb}: ${positional[1]}` : r2.error ?? "nothing changed");
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
  for (const [room2, list] of all) {
    if (!list.length)
      continue;
    console.log(`
  #${room2}`);
    for (const t of list) {
      const who = t.state === "claimed" ? `claimed by ${t.claimedBy}` : t.for ? `for ${t.for}` : "open";
      console.log(`    ${t.id}  ${t.text}`);
      console.log(`${" ".repeat(12)}${who}, from ${t.by}`);
    }
  }
  console.log();
}
async function factsCmd() {
  await ensureDaemon(ROOT_DIR);
  const verb = positional[0];
  if (verb === "add" || verb === "remember") {
    const text = positional.slice(1).join(" ");
    const r2 = await request({ op: "facts", write: "add", text, tags: (flag("--in") ?? "").split(",").filter(Boolean) });
    return console.log(r2.ok ? `remembered in #${r2.room}` : `not saved: ${r2.error}`);
  }
  if (verb === "confirm" || verb === "correct" || verb === "forget") {
    const map = { confirm: "confirm", correct: "supersede", forget: "remove" };
    const r2 = await request({
      op: "facts",
      write: map[verb],
      id: positional[1],
      text: positional.slice(2).join(" ") || undefined,
      reason: flag("--because")
    });
    return console.log(r2.ok ? `${verb}ed ${positional[1]}` : `nothing changed: ${r2.error ?? "no such fact"}`);
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
  for (const [room2, list] of all) {
    if (!list.length)
      continue;
    console.log(`
  #${room2}`);
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
along with everyone it is paired with. Move ~/.claude/crosstalk aside first if
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
    const first = await fetch(`${httpBase()}/pair/${inv.slot}?part=a`);
    if (!first.ok)
      die("no link waiting on that number. They last fifteen minutes.");
    const theirPoint = (await first.json()).blob;
    const half2 = begin(inv.phrase, inv.slot);
    const key2 = finish(half2, theirPoint, inv.slot, "crosstalk/link/v1");
    if (!key2)
      die("could not use that link. Check the words.");
    await fetch(`${httpBase()}/pair/${inv.slot}?part=b`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blob: half2.message })
    });
    let bundle2;
    for (let i = 0;i < 120; i++) {
      const r = await fetch(`${httpBase()}/pair/${inv.slot}?part=c`).catch(() => null);
      if (r?.ok) {
        try {
          const raw = JSON.parse(open(key2, (await r.json()).blob));
          bundle2 = JSON.parse(zlib.gunzipSync(Buffer.from(raw.z, "base64")).toString("utf8"));
        } catch {
          return die("could not read what came back. Start again.");
        }
        break;
      }
      await new Promise((res2) => setTimeout(res2, 1000));
    }
    if (!bundle2)
      die("the other machine never sent anything. Start again.");
    fs6.mkdirSync(ROOT, { recursive: true, mode: 448 });
    const write = (name, value) => fs6.writeFileSync(path8.join(ROOT, name), JSON.stringify(value, null, 2), { mode: 384 });
    write("identity.json", { ...bundle2.identity, machine: machineName() });
    write("peers.json", bundle2.peers ?? {});
    if (bundle2.rooms)
      write("rooms.json", bundle2.rooms);
    if (bundle2.trust)
      write("trust.json", bundle2.trust);
    if (bundle2.relay)
      write("relay.json", bundle2.relay);
    await ensureDaemon(ROOT_DIR);
    console.log(`
This machine is now "${bundle2.identity.label}", the same one as your other machine.

  ${fingerprint(bundle2.identity.ed.pub)}

Everyone you had paired with came across. In a room you appear once, not twice,
and a message reaches whichever machine you are sitting at.`);
    return;
  }
  if (!id)
    die("nothing to link yet. Pair with someone first, or run this on the machine that already has your identity.");
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
        return JSON.parse(fs6.readFileSync(path8.join(ROOT, "rooms.json"), "utf8"));
      } catch {
        return {};
      }
    })(),
    trust: load2(),
    relay: loadRelay()
  };
  const z = zlib.gzipSync(Buffer.from(JSON.stringify(bundle), "utf8")).toString("base64");
  const url = url0;
  await fetch(`${httpBase(url)}/pair/${slot}?part=a`, {
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
    const r = await fetch(`${httpBase(url)}/pair/${slot}?part=b`).catch(() => null);
    if (r?.ok) {
      key = finish(half, (await r.json()).blob, slot, "crosstalk/link/v1");
      break;
    }
    await new Promise((res2) => setTimeout(res2, 1000));
  }
  if (!key)
    die("the other machine never answered.");
  const sealed = seal(key, JSON.stringify({ z }));
  if (sealed.length > 8000)
    die("too much to send in one go. This happens with a lot of peers; copy ~/.claude/crosstalk across by hand instead.");
  const res = await fetch(`${httpBase(url)}/pair/${slot}?part=c`, {
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
  const dir = path8.join(os5.homedir(), ".gemini", "config");
  const file = path8.join(dir, "hooks.json");
  fs6.mkdirSync(dir, { recursive: true });
  let all = {};
  if (fs6.existsSync(file)) {
    try {
      all = JSON.parse(fs6.readFileSync(file, "utf8"));
    } catch {
      die(`${file} is not valid JSON. Fix or move it, then run this again.`);
    }
  }
  all.crosstalk = {
    PreInvocation: [
      { type: "command", command: `"${bin}" hook PreInvocation`, timeout: 20 }
    ]
  };
  fs6.writeFileSync(file, JSON.stringify(all, null, 2) + `
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
  const dir = path8.join(os5.homedir(), ".qwen");
  const file = path8.join(dir, "settings.json");
  fs6.mkdirSync(dir, { recursive: true });
  let cfg = {};
  if (fs6.existsSync(file)) {
    try {
      cfg = JSON.parse(fs6.readFileSync(file, "utf8"));
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
  fs6.writeFileSync(file, JSON.stringify(cfg, null, 2) + `
`);
  console.log(`hooks    ${file}`);
  console.log(`tools    add the MCP server: qwen mcp add crosstalk ${bin} server`);
}
async function installKimi() {
  const bin = shim2(rootFrom2(import.meta.url));
  const dir = path8.join(os5.homedir(), ".kimi-code");
  const file = path8.join(dir, "config.toml");
  fs6.mkdirSync(dir, { recursive: true });
  const existing = fs6.existsSync(file) ? fs6.readFileSync(file, "utf8") : "";
  const kept = existing.replace(/\n*# crosstalk\n(?:\[\[hooks\]\][^[]*)+/g, `
`);
  const blocks = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"].map((event) => `[[hooks]]
event = "${event}"
command = "${bin} hook"
timeout = 20
`).join(`
`);
  fs6.writeFileSync(file, `${kept.trimEnd()}

# crosstalk
${blocks}`);
  console.log(`hooks    ${file}`);
  console.log(`tools    add the MCP server in ${path8.join(dir, "mcp.json")}`);
}
async function installHermes() {
  const bin = shim2(rootFrom2(import.meta.url));
  const dir = path8.join(os5.homedir(), ".hermes");
  const file = path8.join(dir, "config.yaml");
  if (!fs6.existsSync(file))
    die(`no ${file}. Run hermes once first, then run this again.`);
  const existing = fs6.readFileSync(file, "utf8");
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
  fs6.writeFileSync(file, `${existing.trimEnd()}

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
  die(`usage: crosstalk install <agy|qwen|kimi|hermes>

Claude Code and Codex install as a plugin instead:
  /plugin marketplace add epode-studio/crosstalk
  /plugin install crosstalk@epode`);
}
var commands = {
  pair,
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
  policy,
  cost,
  status,
  doctor,
  daemon,
  relay,
  install
};
await (commands[cmd] ?? (async () => die(`unknown command "${cmd}"`)))();
