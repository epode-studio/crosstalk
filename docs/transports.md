# Getting messages between two machines

Crosstalk needs a path between two people's machines. Both are usually behind a
router that hides them, so they cannot simply connect to each other. This records
what was tried, with numbers, so the next attempt does not retread it.

## What works today

**Same network.** Nothing to run. `/crosstalk:pair --host` starts a relay on your
machine, and the invite carries its name over mDNS, so the other side finds it
with no address to type. Verified between two MacBooks.

**A relay someone runs.** Any machine either of you can reach. `deploy/` has a
Dockerfile and a fly.toml. This is the only thing that works between two people
on different networks with nothing else set up.

## What everyone else does

Every project that solves this uses a small always-on server in the middle and
makes it unable to read anything.

- **Magic Wormhole**: a WebSocket rendezvous server, SPAKE2 so the code can be 16
  bits, direct connection attempted using exchanged address hints, transit relay
  as fallback.
- **croc**: the same shape, human-readable codes, public relay.
- **Syncthing**: global discovery servers plus a pool of relays donated by
  volunteers, which is how it scales without the project paying.
- **libp2p and iroh**: a DHT for discovery, hole punching, circuit relays when
  that fails.

The lesson worth taking is not the relay. It is that a **PAKE** lets a short
spoken code stay safe. Crosstalk currently hashes its four words and hands the
hash to the relay, so anyone who sees that hash can grind it offline in minutes.
Under SPAKE2 there is nothing to take away and grind: a guess costs a live
handshake, one at a time, against a code that stops working after one use. That
is why wormhole's 16-bit codes are safer than our 32-bit ones.

## What was measured and rejected

**ntfy.sh, a free public pub/sub.** A room would be a topic, both sides subscribe,
messages are sealed before they are published. No relay, no address, no NAT. It
works, and then it stops:

```
one way latency              355 ms
message up to 4095 bytes     arrives intact
message of 4096 bytes        becomes an attachment reference
publishing without an account  32 messages, then HTTP 429
```

The rate limit is per IP and shared across topics, so it is not a per-room
budget. One 120 KB diff needs 62 chunks, twice the entire allowance. Rejected.
The module is still here as `src/topic.ts`, with chunking and offline catch-up
working, in case a service with usable limits turns up.

**cloudflared quick tunnels.** A public URL with no account, and the hostname it
generates is itself four words, which suits an invite. It never carried traffic
from this machine: the tunnel registered one connection where there are normally
four, and the Cloudflare edge answered 404 for over a minute over QUIC and did
not respond at all over HTTP/2. `trycloudflare.com` itself was reachable, so it
was not a blocked network. Rejected as unreliable.

**serveo, over plain ssh.** Worked first time, HTTP 200 through a public URL with
nothing installed. The hostname is sixteen hex characters plus your public IP,
which nobody can say out loud, and reserving a readable name needs an account.
Worth revisiting if the naming can be solved.

**Tailscale.** Already detected, and it makes the cross-network case as friendly
as the local one: the invite becomes a short tailnet name that works anywhere.
The obstacle is not installation, it is that Tailscale is per-tailnet, so two
different people are on different tailnets and connecting them means an invite or
a shared node from the admin console. Excellent for your own two machines,
high friction between colleagues.

## What would remove the problem rather than move it

Exchange address hints during pairing and punch through the NAT with a free
public STUN server, the way iroh and WebRTC do. Most pairs then talk directly and
touch no server at all, and whatever relay exists carries only the minority of
pairs behind a NAT that will not cooperate. It is the only design where going
viral does not mean paying more.

## The shape a second transport needs

Rooms are the concept; how their messages travel is a detail underneath. A
transport has to offer four things:

```
connect()                    start, and keep trying
close()
connected                    is the link up right now
send(frame): Promise<bool>   false means it was not sent
onFrame(cb)                  frames arriving, in order where possible
```

The relay and `src/topic.ts` both fit this. Everything above it, sealing,
rooms, triage and injection, is transport independent already.
