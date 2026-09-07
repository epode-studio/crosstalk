#!/usr/bin/env bun
// @bun

// src/crypto.ts
import crypto from "node:crypto";
var un64 = (s) => Buffer.from(s, "base64");
function fingerprint(edPubB64) {
  const h = crypto.createHash("sha256").update(un64(edPubB64)).digest("hex");
  return h.slice(0, 16).match(/.{4}/g).join("-");
}

// src/link.ts
import crypto2 from "node:crypto";
var b64 = (b) => Buffer.from(b).toString("base64");
var un642 = (s) => Buffer.from(s, "base64");
function newEd25519() {
  const k = crypto2.generateKeyPairSync("ed25519");
  return {
    pub: b64(k.publicKey.export({ type: "spki", format: "der" })),
    priv: b64(k.privateKey.export({ type: "pkcs8", format: "der" }))
  };
}
var edPrivKey = (priv) => crypto2.createPrivateKey({ key: un642(priv), type: "pkcs8", format: "der" });
var edPubKey = (pub) => crypto2.createPublicKey({ key: un642(pub), type: "spki", format: "der" });
var signWith = (priv, data) => b64(crypto2.sign(null, data, edPrivKey(priv)));
function verifyWith(pub, data, sig) {
  try {
    return crypto2.verify(null, data, edPubKey(pub), un642(sig));
  } catch {
    return false;
  }
}
function newEphemeral() {
  const k = crypto2.generateKeyPairSync("x25519");
  return {
    pub: b64(k.publicKey.export({ type: "spki", format: "der" })),
    key: k.privateKey
  };
}
var xPubKey = (pub) => crypto2.createPublicKey({ key: un642(pub), type: "spki", format: "der" });
var transcript = (relayEph, clientEph, nonce) => Buffer.from(`crosstalk/link/v1|${relayEph}|${clientEph}|${nonce}`);
function derive(ownEphemeral, peerEphPub, transcriptBytes, role) {
  const shared = crypto2.diffieHellman({ privateKey: ownEphemeral, publicKey: xPubKey(peerEphPub) });
  const okm = Buffer.from(crypto2.hkdfSync("sha256", shared, transcriptBytes, "crosstalk/link/keys/v1", 64));
  const relayToClient = okm.subarray(0, 32);
  const clientToRelay = okm.subarray(32, 64);
  return role === "relay" ? { send: relayToClient, recv: clientToRelay } : { send: clientToRelay, recv: relayToClient };
}

class Channel {
  keys;
  out = 0;
  lastIn = -1;
  constructor(keys) {
    this.keys = keys;
  }
  seal(payload) {
    const n = this.out++;
    const nonce = Buffer.alloc(12);
    nonce.writeUInt32BE(n, 8);
    const c = crypto2.createCipheriv("aes-256-gcm", this.keys.send, nonce);
    const ct = Buffer.concat([c.update(JSON.stringify(payload), "utf8"), c.final()]);
    return JSON.stringify({ n, c: b64(Buffer.concat([c.getAuthTag(), ct])) });
  }
  open(raw) {
    const { n, c } = JSON.parse(raw);
    if (typeof n !== "number" || n <= this.lastIn)
      throw new Error("replayed or reordered frame");
    const nonce = Buffer.alloc(12);
    nonce.writeUInt32BE(n, 8);
    const buf = un642(c);
    const d = crypto2.createDecipheriv("aes-256-gcm", this.keys.recv, nonce);
    d.setAuthTag(buf.subarray(0, 16));
    const out = Buffer.concat([d.update(buf.subarray(16)), d.final()]).toString("utf8");
    this.lastIn = n;
    return JSON.parse(out);
  }
}

// relay/relay.ts
import crypto3 from "crypto";
import fs from "fs";
import http from "http";
import { WebSocketServer } from "ws";
var argv = process.argv.slice(2);
var arg = (f, d) => {
  const i = argv.indexOf(f);
  return i === -1 ? d : argv[i + 1];
};
var PORT = Number(arg("--port", process.env.PORT ?? "8787"));
var HOST = arg("--host", "127.0.0.1");
var BUFFER_TTL_MS = 24 * 60 * 60 * 1000;
var MAX_BUFFERED_PER_SENDER = 200;
var MAX_BODY = 1 << 20;
var live = new Map;
var buffered = new Map;
var seen = new Map;
var rate = new Map;
var log = (...a) => console.log(new Date().toISOString(), ...a);
function send(ws, frame) {
  const d = ws.data;
  if (!d.ch)
    return;
  try {
    ws.send(d.ch.seal(frame));
  } catch {}
}
function sweep() {
  const now = Date.now();
  for (const [key, q] of buffered) {
    const kept = q.filter((m) => now - m.ts < BUFFER_TTL_MS);
    if (kept.length)
      buffered.set(key, kept);
    else
      buffered.delete(key);
  }
  for (const [id, ts] of seen)
    if (now - ts > 10 * 60000)
      seen.delete(id);
}
setInterval(sweep, 60000);
function rateOk(fp) {
  const now = Date.now();
  const win = (rate.get(fp) ?? []).filter((t) => now - t < 60000);
  win.push(now);
  rate.set(fp, win);
  return win.length <= 60;
}
function drain(fp, ws) {
  let sent = 0;
  for (const [key, q] of [...buffered]) {
    if (!key.startsWith(`${fp}|`))
      continue;
    buffered.delete(key);
    for (const m of q) {
      send(ws, m.roomId ? { t: "room_deliver", roomId: m.roomId, from: m.from, body: m.body, id: m.id } : { t: "deliver", from: m.from, body: m.body, id: m.id });
      sent++;
    }
  }
  if (sent)
    log(`drained ${sent} buffered to ${fp}`);
}
function announce(fp) {
  const online = [...live.keys()];
  for (const set of live.values())
    for (const ws of set)
      send(ws, { t: "presence", peers: online });
}
var offers = new Map;
var pairRate = new Map;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pairRate) {
    const win = v.filter((t) => now - t < 60000);
    if (win.length)
      pairRate.set(k, win);
    else
      pairRate.delete(k);
  }
}, 60000);
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of offers)
    if (now - v.ts > 15 * 60000)
      offers.delete(k);
}, 60000);
var IDENTITY_FILE = process.env.CROSSTALK_RELAY_IDENTITY ?? "./crosstalk-relay-identity.json";
var relayIdentity = (() => {
  try {
    return JSON.parse(fs.readFileSync(IDENTITY_FILE, "utf8"));
  } catch {
    const k = newEd25519();
    fs.writeFileSync(IDENTITY_FILE, JSON.stringify(k), { mode: 384 });
    return k;
  }
})();
var ROOMS_FILE = process.env.CROSSTALK_RELAY_STATE ?? "./crosstalk-rooms.json";
var roomState = (() => {
  try {
    return JSON.parse(fs.readFileSync(ROOMS_FILE, "utf8"));
  } catch {
    return {};
  }
})();
var saveRooms = () => {
  try {
    fs.writeFileSync(ROOMS_FILE, JSON.stringify(roomState), { mode: 384 });
  } catch {}
};
var joined = (room, fp) => room.members[fp]?.state === "joined";
var roster = (room) => ({
  id: room.id,
  name: room.name,
  members: Object.values(room.members).map((m) => ({
    fingerprint: m.fingerprint,
    label: m.label,
    addedBy: m.addedBy,
    state: m.state
  }))
});
function announceRoom(room) {
  for (const m of Object.values(room.members)) {
    for (const ws of live.get(m.fingerprint) ?? [])
      send(ws, { t: "room", room: roster(room) });
  }
}
function handleRoom(ws, d, f) {
  const me = d.fp;
  switch (f.t) {
    case "room_create": {
      const id = String(f.id ?? "").slice(0, 32);
      if (!id || roomState[id])
        return true;
      roomState[id] = {
        id,
        name: String(f.name ?? "room").slice(0, 64),
        createdBy: me,
        createdAt: Date.now(),
        members: {
          [me]: { fingerprint: me, label: d.label ?? "?", addedBy: me, addedAt: Date.now(), state: "joined" }
        }
      };
      saveRooms();
      announceRoom(roomState[id]);
      return true;
    }
    case "room_invite": {
      const room = roomState[f.roomId];
      if (!room || !joined(room, me))
        return true;
      const fp = String(f.fingerprint ?? "");
      if (!fp || room.members[fp])
        return true;
      room.members[fp] = {
        fingerprint: fp,
        label: String(f.label ?? "?").slice(0, 64),
        addedBy: me,
        addedAt: Date.now(),
        state: "invited"
      };
      saveRooms();
      announceRoom(room);
      return true;
    }
    case "room_accept":
    case "room_decline":
    case "room_leave": {
      const room = roomState[f.roomId];
      if (!room || !room.members[me])
        return true;
      if (f.t === "room_accept")
        room.members[me].state = "joined";
      else
        delete room.members[me];
      announceRoom(room);
      if (f.t !== "room_accept")
        for (const ws2 of live.get(me) ?? [])
          send(ws2, { t: "room_gone", roomId: room.id });
      if (!Object.keys(room.members).length)
        delete roomState[room.id];
      saveRooms();
      return true;
    }
    case "room_kick": {
      const room = roomState[f.roomId];
      const fp = String(f.fingerprint ?? "");
      if (!room || !joined(room, me) || !room.members[fp] || fp === me)
        return true;
      delete room.members[fp];
      saveRooms();
      announceRoom(room);
      for (const ws2 of live.get(fp) ?? [])
        send(ws2, { t: "room_gone", roomId: room.id });
      return true;
    }
    case "room_list": {
      send(ws, {
        t: "rooms",
        rooms: Object.values(roomState).filter((x) => x.members[me]).map(roster)
      });
      return true;
    }
    case "room_send": {
      const room = roomState[f.roomId];
      if (!room || !joined(room, me))
        return true;
      if (!rateOk(me))
        return true;
      if (typeof f.body !== "string" || f.body.length > MAX_BODY)
        return true;
      if (seen.has(f.id))
        return true;
      seen.set(f.id, Date.now());
      for (const m of Object.values(room.members)) {
        if (m.fingerprint === me || m.state !== "joined")
          continue;
        const out = { t: "room_deliver", roomId: room.id, from: me, body: f.body, id: f.id };
        const targets = live.get(m.fingerprint);
        if (targets?.size)
          for (const t of targets)
            send(t, out);
        else {
          const key = `${m.fingerprint}|${me}`;
          const q = buffered.get(key) ?? [];
          q.push({ from: me, body: f.body, id: f.id, ts: Date.now(), roomId: room.id });
          buffered.set(key, q.slice(-MAX_BUFFERED_PER_SENDER));
        }
      }
      send(ws, { t: "ack", id: f.id });
      return true;
    }
  }
  return false;
}
function onMessage(ws, raw) {
  const d = ws.data;
  if (!d.authed) {
    let f2;
    try {
      f2 = JSON.parse(String(raw));
    } catch {
      return ws.close();
    }
    if (f2.t !== "hello" || !f2.ephPub || !f2.pub || !f2.sig)
      return ws.close();
    const t = transcript(d.eph.pub, f2.ephPub, d.nonce);
    if (!verifyWith(f2.pub, t, f2.sig)) {
      ws.send(JSON.stringify({ t: "error", message: "bad signature" }));
      return ws.close();
    }
    d.ch = new Channel(derive(d.eph.key, f2.ephPub, t, "relay"));
    d.fp = fingerprint(f2.pub);
    d.label = f2.label;
    d.authed = true;
    if (!live.has(d.fp))
      live.set(d.fp, new Set);
    live.get(d.fp).add(ws);
    send(ws, { t: "ready", fingerprint: d.fp, sig: signWith(relayIdentity.priv, t) });
    log(`link up ${d.label} ${d.fp}`);
    drain(d.fp, ws);
    announce(d.fp);
    return;
  }
  let f;
  try {
    f = d.ch.open(String(raw));
  } catch {
    log(`bad frame from ${d.label ?? "?"}; closing`);
    return ws.close();
  }
  if (f.t === "ping")
    return send(ws, { t: "pong" });
  if (typeof f.t === "string" && f.t.startsWith("room_") && handleRoom(ws, d, f))
    return;
  if (f.t === "send") {
    if (!rateOk(d.fp))
      return send(ws, { t: "error", message: "rate limited" });
    if (typeof f.body !== "string" || f.body.length > MAX_BODY)
      return send(ws, { t: "error", message: "body too large" });
    if (seen.has(f.id))
      return send(ws, { t: "ack", id: f.id });
    seen.set(f.id, Date.now());
    const out = { t: "deliver", from: d.fp, body: f.body, id: f.id };
    const targets = live.get(f.to);
    if (targets?.size) {
      for (const t of targets)
        send(t, out);
    } else {
      const key = `${f.to}|${d.fp}`;
      const q = buffered.get(key) ?? [];
      q.push({ from: d.fp, body: f.body, id: f.id, ts: Date.now() });
      buffered.set(key, q.slice(-MAX_BUFFERED_PER_SENDER));
    }
    send(ws, { t: "ack", id: f.id });
  }
}
function onClose(ws) {
  const d = ws.data;
  if (!d.fp)
    return;
  const set = live.get(d.fp);
  set?.delete(ws);
  if (set && !set.size)
    live.delete(d.fp);
  log(`closed ${d.label ?? "?"} ${d.fp}`);
  announce(d.fp);
}
var httpServer = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const json = (body, status = 200) => {
    const s = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
    res.end(s);
  };
  if (url.pathname === "/health")
    return json({ ok: true, online: live.size });
  if (url.pathname === "/pubkey")
    return json({ pub: relayIdentity.pub });
  const m = url.pathname.match(/^\/pair\/([A-Z0-9]{4,16})$/);
  if (m) {
    const code = m[1];
    const slot = url.searchParams.get("side") === "reply" ? "reply" : "offer";
    if (req.method === "GET" && slot === "offer") {
      const who = req.socket.remoteAddress ?? "unknown";
      const now = Date.now();
      const win = (pairRate.get(who) ?? []).filter((t) => now - t < 60000);
      win.push(now);
      pairRate.set(who, win);
      if (win.length > 30)
        return json({ error: "too many pairing attempts" }, 429);
    }
    if (req.method === "POST") {
      let raw = "";
      req.on("data", (c) => {
        raw += c;
        if (raw.length > 16384)
          req.destroy();
      });
      req.on("end", () => {
        let blob;
        try {
          blob = JSON.parse(raw).blob;
        } catch {
          return json({ error: "bad body" }, 400);
        }
        if (typeof blob !== "string" || blob.length > 8192)
          return json({ error: "bad blob" }, 400);
        const e = offers.get(code) ?? { ts: Date.now() };
        if (e[slot])
          return json({ error: "slot already filled" }, 409);
        e[slot] = blob;
        e.ts = Date.now();
        offers.set(code, e);
        json({ ok: true });
      });
      return;
    }
    if (req.method === "GET") {
      const e = offers.get(code);
      if (!e?.[slot])
        return json({ error: "not ready" }, 404);
      return json({ blob: e[slot] });
    }
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("crosstalk relay");
});
var wss = new WebSocketServer({ server: httpServer, path: "/ws" });
wss.on("connection", (ws) => {
  const d = {
    nonce: crypto3.randomBytes(24).toString("base64"),
    authed: false,
    eph: newEphemeral()
  };
  ws.data = d;
  ws.send(JSON.stringify({ t: "hello", ephPub: d.eph.pub, nonce: d.nonce }));
  ws.on("message", (raw) => onMessage(ws, String(raw)));
  ws.on("close", () => onClose(ws));
  ws.on("error", () => {});
});
httpServer.listen(PORT, HOST, () => log(`crosstalk relay on ws://${HOST}:${PORT}/ws`));
