#!/usr/bin/env bun
// @bun

// src/crypto.ts
import crypto from "node:crypto";
var un64 = (s) => Buffer.from(s, "base64");
function fingerprint(edPubB64) {
  const h = crypto.createHash("sha256").update(un64(edPubB64)).digest("hex");
  return h.slice(0, 16).match(/.{4}/g).join("-");
}
var SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

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
import crypto4 from "crypto";
import fs from "fs";

// relay/serve.ts
import http from "node:http";

// relay/wsserver.ts
import crypto3 from "node:crypto";
var GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
var accept = (key) => crypto3.createHash("sha1").update(key + GUID).digest("base64");
function frame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 128 | opcode;
  return Buffer.concat([header, payload]);
}
function upgrade(req, socket, head, maxPayload = 4 << 20) {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || (req.headers.upgrade ?? "").toLowerCase() !== "websocket") {
    socket.end(`HTTP/1.1 400 Bad Request\r
\r
`);
    return null;
  }
  socket.write(`HTTP/1.1 101 Switching Protocols\r
` + `Upgrade: websocket\r
` + `Connection: Upgrade\r
` + `Sec-WebSocket-Accept: ${accept(key)}\r
\r
`);
  socket.setNoDelay(true);
  const ws = {
    remoteAddress: socket.remoteAddress,
    send(text) {
      if (socket.writable)
        socket.write(frame(1, Buffer.from(text, "utf8")));
    },
    close() {
      if (socket.writable)
        socket.write(frame(8, Buffer.alloc(0)));
      socket.end();
    }
  };
  let buf = head?.length ? Buffer.from(head) : Buffer.alloc(0);
  let fragments = [];
  let fragmentOpcode = 0;
  const fail = () => {
    try {
      socket.destroy();
    } catch {}
  };
  socket.on("data", (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;; ) {
      if (buf.length < 2)
        return;
      const fin = (buf[0] & 128) !== 0;
      const opcode = buf[0] & 15;
      const masked = (buf[1] & 128) !== 0;
      let len = buf[1] & 127;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4)
          return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10)
          return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(maxPayload))
          return fail();
        len = Number(big);
        offset = 10;
      }
      if (len > maxPayload)
        return fail();
      if (!masked)
        return fail();
      if (buf.length < offset + 4 + len)
        return;
      const mask = buf.subarray(offset, offset + 4);
      const payload = Buffer.allocUnsafe(len);
      for (let i = 0;i < len; i++)
        payload[i] = buf[offset + 4 + i] ^ mask[i & 3];
      buf = buf.subarray(offset + 4 + len);
      if (opcode === 8) {
        ws.close();
        return;
      }
      if (opcode === 9) {
        if (socket.writable)
          socket.write(frame(10, payload));
        continue;
      }
      if (opcode === 10)
        continue;
      if (opcode === 0) {
        fragments.push(payload);
      } else {
        fragments = [payload];
        fragmentOpcode = opcode;
      }
      if (!fin)
        continue;
      const whole = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments);
      fragments = [];
      if (fragmentOpcode === 1)
        ws.onMessage?.(whole.toString("utf8"));
    }
  });
  socket.on("close", () => ws.onClose?.());
  socket.on("error", () => ws.onClose?.());
  return ws;
}

// relay/serve.ts
var isBun = typeof globalThis.Bun !== "undefined";
function serve(o) {
  return isBun ? serveBun(o) : serveNode(o);
}
function serveBun(o) {
  const Bun = globalThis.Bun;
  Bun.serve({
    port: o.port,
    hostname: o.host,
    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === o.path) {
        const ok = server.upgrade(req, { data: { conn: null } });
        return ok ? undefined : new Response("upgrade failed", { status: 400 });
      }
      const reply = await o.http({
        method: req.method,
        url,
        body: () => req.text(),
        remoteAddress: server.requestIP(req)?.address
      });
      return new Response(reply.body, {
        status: reply.status,
        headers: { "content-type": reply.type ?? "application/json" }
      });
    },
    websocket: {
      open(ws) {
        const conn = {
          send: (t) => {
            try {
              ws.send(t);
            } catch {}
          },
          close: () => ws.close(),
          remoteAddress: ws.remoteAddress,
          data: {}
        };
        ws.data.conn = conn;
        o.open(conn);
      },
      message(ws, raw) {
        if (ws.data.conn)
          o.message(ws.data.conn, String(raw));
      },
      close(ws) {
        if (ws.data.conn)
          o.close(ws.data.conn);
      }
    }
  });
  o.onListen?.();
}
function serveNode(o) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const body = () => new Promise((resolve) => {
      let raw = "";
      req.on("data", (c) => {
        raw += c;
        if (raw.length > 1 << 20)
          req.destroy();
      });
      req.on("end", () => resolve(raw));
      req.on("error", () => resolve(""));
    });
    const reply = await o.http({
      method: req.method ?? "GET",
      url,
      body,
      remoteAddress: req.socket.remoteAddress
    });
    res.writeHead(reply.status, {
      "content-type": reply.type ?? "application/json",
      "content-length": Buffer.byteLength(reply.body)
    });
    res.end(reply.body);
  });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== o.path) {
      socket.end(`HTTP/1.1 404 Not Found\r
\r
`);
      return;
    }
    const ws = upgrade(req, socket, head);
    if (!ws)
      return;
    const conn = {
      send: ws.send,
      close: ws.close,
      remoteAddress: ws.remoteAddress,
      data: {}
    };
    ws.onMessage = (t) => o.message(conn, t);
    ws.onClose = () => o.close(conn);
    o.open(conn);
  });
  server.listen(o.port, o.host, () => o.onListen?.());
}

// relay/relay.ts
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
var state = (ws) => ws.data;
var live = new Map;
var buffered = new Map((() => {
  try {
    return JSON.parse(fs.readFileSync((process.env.CROSSTALK_RELAY_STATE ?? "./crosstalk-rooms.json").replace(/\.json$/, "-buffer.json"), "utf8"));
  } catch {
    return [];
  }
})());
var seen = new Map;
var rate = new Map;
var log = (...a) => console.log(new Date().toISOString(), ...a);
function send(ws, frame2) {
  const d = state(ws);
  if (!d.ch)
    return;
  try {
    ws.send(d.ch.seal(frame2));
  } catch {}
}
var BUFFER_FILE = (process.env.CROSSTALK_RELAY_STATE ?? "./crosstalk-rooms.json").replace(/\.json$/, "-buffer.json");
var bufferDirty = false;
var saveBuffer = () => {
  if (!bufferDirty)
    return;
  bufferDirty = false;
  try {
    fs.writeFileSync(BUFFER_FILE, JSON.stringify([...buffered]), { mode: 384 });
  } catch {}
};
setInterval(saveBuffer, 5000);
for (const sig of ["SIGINT", "SIGTERM"])
  process.on(sig, () => {
    saveBuffer();
    process.exit(0);
  });
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
    bufferDirty = true;
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
          bufferDirty = true;
        }
      }
      send(ws, { t: "ack", id: f.id });
      return true;
    }
  }
  return false;
}
function onMessage(ws, raw) {
  const d = state(ws);
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
      bufferDirty = true;
    }
    send(ws, { t: "ack", id: f.id });
  }
}
function onClose(ws) {
  const d = state(ws);
  if (!d.fp)
    return;
  const set = live.get(d.fp);
  set?.delete(ws);
  if (set && !set.size)
    live.delete(d.fp);
  log(`closed ${d.label ?? "?"} ${d.fp}`);
  announce(d.fp);
}
serve({
  port: PORT,
  host: HOST,
  path: "/ws",
  http: async ({ method, url, body, remoteAddress }) => {
    const json = (o, status = 200) => ({ status, body: JSON.stringify(o) });
    if (url.pathname === "/health")
      return json({ ok: true, online: live.size });
    if (url.pathname === "/pubkey")
      return json({ pub: relayIdentity.pub });
    if (url.pathname === "/slot" && method === "POST") {
      for (let attempt = 0;attempt < 20; attempt++) {
        const slot2 = String(Math.floor(Math.random() * 9000) + 1000);
        if (!offers.has(slot2)) {
          offers.set(slot2, { ts: Date.now() });
          return json({ slot: slot2 });
        }
      }
      return json({ error: "no free slot, try again" }, 503);
    }
    const m = url.pathname.match(/^\/pair\/([A-Za-z0-9]{1,32})$/);
    if (m) {
      const code = m[1];
      const part = url.searchParams.get("part") ?? "a";
      if (!/^[abc]$/.test(part))
        return json({ error: "bad part" }, 400);
      if (method === "GET") {
        const who = remoteAddress ?? "unknown";
        const now = Date.now();
        const win = (pairRate.get(who) ?? []).filter((t) => now - t < 60000);
        win.push(now);
        pairRate.set(who, win);
        if (win.length > 30)
          return json({ error: "too many pairing attempts" }, 429);
      }
      if (method === "POST") {
        let blob;
        try {
          blob = JSON.parse(await body()).blob;
        } catch {
          return json({ error: "bad body" }, 400);
        }
        if (typeof blob !== "string" || blob.length > 8192)
          return json({ error: "bad blob" }, 400);
        const e = offers.get(code) ?? { ts: Date.now() };
        if (e[part])
          return json({ error: "slot already filled" }, 409);
        e[part] = blob;
        e.ts = Date.now();
        offers.set(code, e);
        return json({ ok: true });
      }
      if (method === "GET") {
        const e = offers.get(code);
        if (!e?.[slot])
          return json({ error: "not ready" }, 404);
        return json({ blob: e[part] });
      }
    }
    return { status: 200, body: "crosstalk relay", type: "text/plain" };
  },
  open(ws) {
    const d = {
      nonce: crypto4.randomBytes(24).toString("base64"),
      authed: false,
      eph: newEphemeral()
    };
    ws.data = d;
    ws.send(JSON.stringify({ t: "hello", ephPub: d.eph.pub, nonce: d.nonce }));
  },
  message: (ws, raw) => onMessage(ws, raw),
  close: (ws) => onClose(ws),
  onListen: () => log(`crosstalk relay on ws://${HOST}:${PORT}/ws`)
});
