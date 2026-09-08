# Testing across two computers

Everything in this repo was developed on one Mac with two identities. The
protocol does not know how many machines are involved, and the relay binds every
interface, so the two sides already talk over a real network interface rather
than loopback. What has never been exercised is the networking around it:
whether the other machine can actually reach yours, what a firewall does to it,
and what happens when a laptop sleeps.

Two ways to find out. The first is the real test. The second needs only this
machine and takes five minutes.

## 1. With a second computer

On the machine that will host the relay:

```
/crosstalk:pair --host
```

Read the four words and the address to the other person. On the second machine:

```
/crosstalk:pair <the four words> @ <the address>
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
Options, or turn the firewall off while you pair.

**Did it pick the wrong address?** A machine with a VPN, a virtual interface or
several network cards can advertise one the other side cannot route to.
`--host` prints every address it found. Redo it with the right one:

```
/crosstalk:pair --host --address 192.168.50.69
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

This runs the other person inside a container, which has its own network stack
and its own filesystem, so it exercises real cross-host TCP, the encrypted link,
and address detection. It does not exercise firewalls, sleep, or NAT.

Start Docker, then:

```
cd test/docker
./run.sh
```

The script starts a relay on your Mac bound to all interfaces, builds a small
image with crosstalk in it, brings up a container as a second person, pairs the
two over your LAN address, sends a message each way, and prints what arrived. It
tears everything down afterwards and touches nothing in `~/.claude`.

A pass here means the protocol and the encrypted link work between two network
stacks. It does not mean crosstalk works between two laptops on hotel wifi. Only
the first test tells you that.
