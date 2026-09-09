# Testing across two computers

crosstalk runs across two Macs day to day, and `docker/nat.sh` covers two peers
on networks that cannot reach each other. The protocol does not count machines
or hops, so what is left is the environment around it: whether the other machine
can reach yours at all, what a firewall does to that, and what happens when a
laptop sleeps mid-conversation.

Three ways to exercise it. The first needs a second computer. The other two need
only this machine.

## 1. With a second computer

On the machine that will host the relay:

```
/crosstalk:room new --host
```

Read the four words and the address to the other person. On the second machine:

```
/crosstalk:room join <the four words> @ <the address>
```

Then, on both:

```
/crosstalk:doctor
```

`relay` must be a tick on both sides. If it is a tick on yours and a cross on
theirs, the problem is reachability, not crosstalk. Work down this list.

**Are you on the same network?** A LAN address only works within one network.
Guest wifi and most café and hotel networks isolate clients from each other, so
two laptops on the same SSID still cannot reach one another. Install Tailscale on
both and rerun `--host`, which will then hand out a tailnet address that works
from anywhere.

**Is the macOS firewall dropping it?** `/crosstalk:doctor` says so on the hosting
machine. It blocks incoming connections per application, and the application here
is `bun` or `node`, so an allow rule for Claude Code does not cover it. Either
allow incoming connections for that binary in System Settings, Network, Firewall,
Options, or turn the firewall off while the two of you connect.

**Did it pick the wrong address?** A machine with a VPN, a virtual interface or
several network cards can advertise one the other side cannot route to.
`--host` prints every address it found. Redo it with the right one:

```
/crosstalk:room new --host --address 192.168.50.69
```

**Check the port directly.** From the second machine:

```
curl -m 3 http://<address>:8787/health
```

`{"ok":true,...}` means the network is fine and the problem is elsewhere. A hang
or a refusal means the connection never arrives, so it is the network, a
firewall, or the wrong address.

**Clocks.** Envelopes more than ten minutes in the future are refused. Two
machines that disagree wildly about the time will drop messages, and the
receiving daemon logs exactly that in `~/.claude/crosstalk/daemon.log`.

**Sleep.** The relay lives on one machine. When that machine sleeps nothing
routes, and the other side retries with a backoff until it returns. Nothing is
lost: a send while the link is down is held on the sending machine and goes when
it comes back, and anything already sitting at the relay for an offline peer
survives a relay restart. Both expire after a day.

A sleeping laptop is worse than a disconnected one, because it leaves the far
end holding a socket that still reports as open while nothing crosses it. The
daemon treats seventy seconds of silence as a dead link and reconnects, so this
resolves itself within about a minute and a half of the machine waking.

If both of you sleep unpredictably, host a relay somewhere that does not:
[`../deploy/`](../deploy/).

## 2. With one computer and Docker

Start Docker, then:

```
bash test/docker/nat.sh
```

Two containers, each on its own bridge network, and a relay on a third that both
can reach. A Docker bridge is a NAT with no port forwarding, and the two peer
networks cannot route to each other, so this is the case the whole transport
design turns on: two people who can dial out and cannot be dialled.

```
   peer-a ──▶ ┐                          ┌ ◀── peer-b
   (net-a)    ├──▶ relay (net-relay) ◀───┤    (net-b)
              ┘                          ┘
   no inbound                              no inbound
```

Twelve assertions: that each peer reaches the relay, that neither reaches the
other, that a room forms across them, that a message crosses, and that neither
side ever opened a listening port on a routable address. It tears everything
down afterwards and touches nothing in `~/.claude`.

A pass means NAT, two network stacks, the encrypted link, room setup and
delivery all work. It says nothing about firewalls, sleep, or a network that
blocks outbound. Only the first test tells you that.

## 3. The public tunnel

```
bash test/tunnel.sh
```

`room new --public` puts a Cloudflare quick tunnel in front of a relay on your
machine, so the invite carries a `wss://<random>.trycloudflare.com` address that
works from anywhere. This runs that path end to end: the tunnel comes up, the
relay answers through it, a second identity joins over the public URL, a message
crosses, and `crosstalk relay stop` closes the tunnel again.

It also covers `--host`, the LAN relay that `--public` falls back to and that
the tunnel's own failure message points at. That half always runs.

Quick tunnels are rate limited, and the throttle is not subtle: after a few in a
short window Cloudflare either issues no hostname at all or issues one it never
publishes DNS for. Measured on a bare `cloudflared --url` against a plain HTTP
server, with no crosstalk involved: three minutes, never routable. So the script
skips that half with a note rather than failing, and says which of the two it
saw. Come back in an hour.
