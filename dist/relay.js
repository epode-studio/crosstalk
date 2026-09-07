#!/usr/bin/env bun
// @bun

// src/crypto.ts
import crypto from "node:crypto";
var un64 = (s) => Buffer.from(s, "base64");
var edPub = (spki) => crypto.createPublicKey({ key: un64(spki), type: "spki", format: "der" });
function fingerprint(edPubB64) {
  const h = crypto.createHash("sha256").update(un64(edPubB64)).digest("hex");
  return h.slice(0, 16).match(/.{4}/g).join("-");
}
var verify = (edPubB64, data, sig) => {
  try {
    return crypto.verify(null, Buffer.from(data), edPub(edPubB64), un64(sig));
  } catch {
    return false;
  }
};

// relay/relay.ts
import crypto2 from "crypto";
var argv = process.argv.slice(2);
var arg = (f, d) => {
  const i = argv.indexOf(f);
  return i === -1 ? d : argv[i + 1];
};
var PORT = Number(arg("--port", process.env.PORT ?? "8787"));
var HOST = arg("--host", "127.0.0.1");
var BUFFER_TTL_MS = 24 * 60 * 60 * 1000;
var MAX_BUFFERED = 200;
var MAX_BODY = 1 << 20;
var live = new Map;
var buffered = new Map;
var seen = new Map;
var rate = new Map;
var log = (...a) => console.log(new Date().toISOString(), ...a);
function sweep() {
  const now = Date.now();
  for (const [fp, q] of buffered) {
    const kept = q.filter((m) => now - m.ts < BUFFER_TTL_MS);
    if (kept.length)
      buffered.set(fp, kept);
    else
      buffered.delete(fp);
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
  const q = buffered.get(fp);
  if (!q?.length)
    return;
  buffered.delete(fp);
  for (const m of q)
    ws.send(JSON.stringify({ t: "deliver", from: m.from, body: m.body, id: m.id }));
  log(`drained ${q.length} buffered to ${fp}`);
}
function announce(fp) {
  const online = [...live.keys()];
  for (const set of live.values())
    for (const ws of set)
      ws.send(JSON.stringify({ t: "presence", peers: online }));
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
Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const ok = server.upgrade(req, {
        data: { nonce: crypto2.randomBytes(24).toString("base64"), authed: false }
      });
      return ok ? undefined : new Response("upgrade failed", { status: 400 });
    }
    if (url.pathname === "/health")
      return Response.json({ ok: true, online: live.size });
    const m = url.pathname.match(/^\/pair\/([A-Z0-9]{4,16})$/);
    if (m) {
      const who = server.requestIP(req)?.address ?? "unknown";
      const now = Date.now();
      const win = (pairRate.get(who) ?? []).filter((t) => now - t < 60000);
      win.push(now);
      pairRate.set(who, win);
      if (win.length > 20)
        return Response.json({ error: "too many pairing attempts" }, { status: 429 });
      const code = m[1];
      const slot = url.searchParams.get("side") === "reply" ? "reply" : "offer";
      if (req.method === "POST") {
        const { blob } = await req.json();
        if (typeof blob !== "string" || blob.length > 8192)
          return Response.json({ error: "bad blob" }, { status: 400 });
        const e = offers.get(code) ?? { ts: Date.now() };
        e[slot] = blob;
        e.ts = Date.now();
        offers.set(code, e);
        return Response.json({ ok: true });
      }
      if (req.method === "GET") {
        const e = offers.get(code);
        if (!e?.[slot])
          return Response.json({ error: "not ready" }, { status: 404 });
        return Response.json({ blob: e[slot] });
      }
    }
    return new Response("crosstalk relay", { status: 200 });
  },
  websocket: {
    open(ws) {
      const d = ws.data;
      ws.send(JSON.stringify({ t: "challenge", nonce: d.nonce }));
    },
    message(ws, raw) {
      const d = ws.data;
      let f;
      try {
        f = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (f.t === "auth") {
        if (!verify(f.pub, d.nonce, f.sig)) {
          ws.send(JSON.stringify({ t: "error", message: "bad signature" }));
          return ws.close();
        }
        d.fp = fingerprint(f.pub);
        d.label = f.label;
        d.authed = true;
        if (!live.has(d.fp))
          live.set(d.fp, new Set);
        live.get(d.fp).add(ws);
        ws.send(JSON.stringify({ t: "ready", fingerprint: d.fp }));
        log(`auth ${d.label} ${d.fp}`);
        drain(d.fp, ws);
        announce(d.fp);
        return;
      }
      if (!d.authed)
        return;
      if (f.t === "ping")
        return ws.send(JSON.stringify({ t: "pong" }));
      if (f.t === "send") {
        if (!rateOk(d.fp))
          return ws.send(JSON.stringify({ t: "error", message: "rate limited" }));
        if (typeof f.body !== "string" || f.body.length > MAX_BODY)
          return ws.send(JSON.stringify({ t: "error", message: "body too large" }));
        if (seen.has(f.id))
          return ws.send(JSON.stringify({ t: "ack", id: f.id }));
        seen.set(f.id, Date.now());
        const out = { t: "deliver", from: d.fp, body: f.body, id: f.id };
        const targets = live.get(f.to);
        if (targets?.size) {
          for (const t of targets)
            t.send(JSON.stringify(out));
        } else {
          const q = buffered.get(f.to) ?? [];
          q.push({ from: d.fp, body: f.body, id: f.id, ts: Date.now() });
          buffered.set(f.to, q.slice(-MAX_BUFFERED));
        }
        ws.send(JSON.stringify({ t: "ack", id: f.id }));
      }
    },
    close(ws) {
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
  }
});
log(`crosstalk relay on ws://${HOST}:${PORT}/ws`);
