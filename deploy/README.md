# Hosting a relay

You do not need one. `/crosstalk:pair --host` starts a relay on your machine for
as long as pairing takes and puts its address in the invite, and after that the
two daemons keep talking to it. That works whenever both machines can reach each
other, same network, or both on the same tailnet.

Host a persistent one when you want the invite to be four words and nothing
else, or when the two machines can never see each other directly.

```
fly deploy -c deploy/fly.toml
```

Then point crosstalk at it, on both machines:

```
/crosstalk:pair --relay wss://crosstalk-relay.fly.dev
```

Or bake it in so it needs no flag: set `CROSSTALK_DEFAULT_RELAY` in the
environment, and invites drop the `@ address` suffix.

The relay authenticates peers by Ed25519 challenge/response, routes sealed
bodies by fingerprint, buffers 24 hours for an offline peer, and rate-limits
both sends and pairing lookups. It sees fingerprints and byte counts. It cannot
read a message, and it cannot read presence either, which repos you work in is
encrypted the same way messages are.
