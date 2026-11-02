# The relay as a Cloudflare Worker

Two machines behind routers can only meet somewhere they can both reach
outbound. That is a property of NAT rather than a design choice, which is why
every system of this kind has a rendezvous point: Magic Wormhole, croc,
Syncthing, Tailscale, WebRTC. The question is never whether there is a server,
only what it costs and what it can see.

A Worker answers both. Idle connections hibernate, so the thing a relay is mostly
made of is nearly free. The free tier fails closed rather than billing, so going
viral cannot produce an invoice you did not choose.

```
100,000 requests / day        free
13,000 GB-s duration / day    free
over the limit                operations fail, they do not bill
```

## Deploy

```
cd worker
npx wrangler deploy
```

The client reaches invites at `/invite/<slot>` and the Durable Object holding
them is `Invites`. Both were called `pair`/`Pairing` until pairing stopped being
a concept, so a relay deployed before that answers the old path and the client
gets a banner instead of an offer. **Redeploy after pulling this**, or joining a
room hangs and then times out with nothing useful in it. `test/e2e.sh` probes
the route before it does anything else and says so in one line.

An applied migration tag is a record of what already happened, so `v1` still
names the class `Pairing` and the rename is `v2`. Editing `v1` in place would
have Cloudflare comparing a tag it has already run against different contents.

Then point crosstalk at it, on both machines:

```
/crosstalk:join --relay wss://crosstalk-relay.<your-subdomain>.workers.dev
```

Set `CROSSTALK_DEFAULT_RELAY` to that URL and invites become four words with
nothing after them, because there is no longer an address to say.

## What it is made of

One **Mailbox** object per identity, holding that identity's live connections and
anything waiting for it while it was offline, for a day. One **Room** object per
room, holding the roster and fanning messages out to member mailboxes. One
**Invites** object per code, holding the two sealed halves of an exchange for
fifteen minutes and then deleting itself. One **StreamPool** object, holding how
many live stream frames everyone together has used today.

## Stream frames

Sharing a running server (`crosstalk_look action "share"`, [`../docs/urls.md`](../docs/urls.md)
section 8) sends many small frames: a request head, 48 KB body chunks, a
response. `ready` says `streams: 1`, as the self-hosted relay's does, plus the
allowance below as `streamAllowance`, and the client sends those frames as
`stream` rather than `send`:

- **Live only.** Relayed to the recipient's connected sockets as `deliver`, and
  otherwise dropped. Never written to storage, never acked, never held for
  someone offline. A sender whose recipient is not connected gets
  `{t:"error", code:"stream_offline"}` once, and frames for them are dropped in
  the sender's own mailbox for five seconds rather than asked about each time.
- **A burst limit**, as `relay/relay.ts`: 1,500 frames or 48 MB per sender per
  ten seconds. Over it: dropped, and one `stream_burst` error per window. The
  client paces well below this.
- **A daily allowance per sender**: 4,000 frames or 256 MB per UTC day.
- **A daily allowance for everyone at once**: 15,000 frames per UTC day, held
  by StreamPool. Mailboxes reserve from it in chunks (50, doubling to 400, never
  more than the sender has left), so it is asked once per tens to hundreds of
  frames, not per frame.
- **Over either day:** further stream frames are refused with one
  `{t:"error", code:"stream_paused", scope:"sender"|"relay", until, message}`,
  `until` being the next 00:00 UTC, when the free plan resets too. The client
  stops streaming until then, never falls back to stored sends for share data
  on this relay, and tells both people in a plain message: "sharing through the
  shared relay is paused until tomorrow; run your own relay with `--host` or
  `worker/`". Ordinary sends, rooms and invites are untouched.

Nothing is written per frame. The count lives in the sender's Mailbox, in
memory, and a copy rides on the sender's socket (`serializeAttachment`, which
survives hibernation and is not storage). It goes to storage when the last
socket closes, every 1,000 frames, and the moment a day is spent, so a
reconnect cannot reset it.

### What a stream frame costs, and why these numbers

The free plan, shared by every user of this relay, fails closed at 100,000
Durable Object requests and 13,000 GB-s a day, reset at 00:00 UTC. From
Cloudflare's Durable Objects pricing: an incoming WebSocket message is billed
at 20:1, outgoing WebSocket messages are free, and each request to an object
(a `fetch` from the Worker or from another object) is one request.

```
one stream frame, relayed:
  incoming WebSocket message on the sender's Mailbox      1/20  = 0.05
  fetch from the sender's Mailbox to the recipient's      1
  StreamPool reservation, at most one per 50 frames       0.02
                                                          ------
                                                          1.07 requests
one refused or dropped frame (burst, day, offline)       0.05 requests

everyone's day:  15,000 frames x 1.07 = 16,050 requests  = 16% of 100,000
one sender:       4,000 frames x 1.07 =  4,280 requests  =  4.3%
one share, both directions (viewer's requests, owner's answers): about 8.6%
duration:  15,000 frames x ~50 ms awake x 128 MB = ~94 GB-s = 0.7% of 13,000
storage:   0 writes per frame; per sender a handful a day; StreamPool at most
           one per reservation, under 300 a day, of 100,000 rows written
```

So however many people share, sharing as a whole stays under a sixth of the
day's requests and leaves the rest for messages. 4,000 frames is around 190 MB
of responses or a few hundred page assets, enough to show someone a page and
click around; anyone who needs more runs their own relay (`--host`, or deploy
this Worker to their own account), where none of this applies.

What this does not stop: a modified client can make the relay count incoming
messages of any kind, frames refused here included (0.05 each), and
fingerprints cost nothing to make, so per-sender limits are a guard against an
honest share running away, not against abuse. StreamPool is what bounds
honest sharing as a whole.

**Redeploy after pulling this** (`npx wrangler deploy`): it adds the
StreamPool object (migration `v3`). Until then the relay does not advertise
streams, and a client from this version sends no share frames through it at
all rather than ordinary sends (which are stored, one write each): it tells the
person once that sharing needs the redeployed relay or one of their own.
Clients from before this version share over the hosted relay as ordinary sends
whatever the Worker says; only upgrading them changes that.

## What it can see

Which fingerprints talk to each other, how large the messages are, when they
arrive, and who is in which room. Never any content: everything in `body` is
sealed with a key the Worker does not have, and presence is sealed the same way,
so it does not learn which repositories you work in either.

## Why there is no encrypted link layer here

The self-hosted relay in [`../relay/`](../relay/) wraps its connection in an
ephemeral X25519 exchange signed by both identities. That exists to hide metadata
from anyone watching a plaintext `ws://` connection on a local network. A Worker
is always `wss://`, so TLS already does that job, and the daemon skips the extra
handshake when it sees a `wss://` URL.

## Testing it without deploying

```
cd worker && npx wrangler dev --port 8790 --local
CROSSTALK_RELAY_KIND=worker bun src/daemon.ts
```

The environment override exists because a local wrangler serves plain `ws`, which
the daemon would otherwise treat as a self-hosted relay.

`bun run test:worker` tests stream frames against a local `wrangler dev` (workerd,
offline): `worker/test/streams.test.ts` the bookkeeping alone,
`worker/test/worker.test.ts` the Worker over WebSockets with the allowance made
small through `--var` (live delivery with nothing in storage, offline dropped and
told once, burst, the sender's day, everyone's day, ordinary sends after), and
`test/share-worker.sh` two daemons sharing a server through it until it pauses.
They need wrangler: on PATH, in `worker/node_modules`, or `WRANGLER=/path`; without
it they say they were skipped. `TEST_HOOKS` and the `STREAM_*` vars are for those
tests only; a deploy sets neither.
