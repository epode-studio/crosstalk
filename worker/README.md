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

Then point crosstalk at it, on both machines:

```
/crosstalk:room new --relay wss://crosstalk-relay.<your-subdomain>.workers.dev
```

Set `CROSSTALK_DEFAULT_RELAY` to that URL and invites become four words with
nothing after them, because there is no longer an address to say.

## What it is made of

One **Mailbox** object per identity, holding that identity's live connections and
anything waiting for it while it was offline, for a day. One **Room** object per
room, holding the roster and fanning messages out to member mailboxes. One
**Exchange** object per code, holding the two sealed halves of an exchange for
fifteen minutes and then deleting itself.

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
