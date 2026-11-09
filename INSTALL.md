# Installing crosstalk: instructions for coding agents

**This file is for you, the coding agent.** A person pasted something like
"Install crosstalk from github.com/epode-studio/crosstalk" into you. Follow the
steps below exactly, in order. Do not install anything else, do not change any
setting not named here, and stop and tell the person if a step fails.

People installing by hand want the [README's Install section](README.md#install)
instead. Both list the same commands.

## 1. Work out which agent you are

You usually know. If not, check in this order and use the first that matches:

| Check | You are |
|---|---|
| `echo "$CLAUDECODE"` prints `1` | Claude Code |
| your parent process (`ps -o comm= -p $PPID`) is `codex` | Codex |
| your parent process is `cursor-agent` | Cursor |
| your parent process is `qwen` | Qwen Code |
| your parent process is `goose` | Goose |
| your parent process is `agy` or you are Google Antigravity | Antigravity |
| your parent process is `kimi` | Kimi Code |
| your parent process is `hermes` | Hermes |

If none matches, say so and stop: crosstalk's hooks are written for these
eight. Any other MCP client can still use the tools: see "Anything else" at the
end.

## 2. Check what crosstalk needs

```
command -v git && (command -v bun || command -v node)
```

Both must print a path. If neither `bun` nor `node` is there, stop and tell the
person to install one of them (bun.sh or nodejs.org); do not install it for them.

## 3. Install, for the agent you are

Run only the block for your agent.

**Claude Code.** In a shell (these are the same as `/plugin marketplace add`
and `/plugin install` inside a session):

```
claude plugin marketplace add epode-studio/crosstalk
claude plugin install crosstalk@epode
```

Updates: tell the person that, in any Claude session, `/plugin` →
**Marketplaces** → **epode** → **Enable auto-update** installs each release by
itself from then on. Turning it on is theirs to do; do not edit their settings
for it.

**Codex**

```
codex plugin marketplace add https://github.com/epode-studio/crosstalk
codex plugin add crosstalk@epode
```

Then tell the person: run `codex`, open `/hooks`, and trust the crosstalk
entries. Codex does not run a hook it has not been told to trust, and says
nothing when it skips one. You cannot do this step for them.

**Cursor**

```
cursor-agent plugin marketplace add https://github.com/epode-studio/crosstalk
```

Then tell the person to run `/plugins` inside `cursor-agent` and install
crosstalk from there.

**Qwen Code**

```
qwen extensions install https://github.com/epode-studio/crosstalk
```

**Goose**

```
goose plugin install https://github.com/epode-studio/crosstalk
```

**Antigravity, Kimi Code, Hermes.** These have no marketplace that takes
crosstalk, so it writes their config itself from a clone. Clone it somewhere
the person keeps tools (ask if unsure; `~/.local/share/crosstalk` is a fine
default), then run the one line for your agent:

```
git clone https://github.com/epode-studio/crosstalk ~/.local/share/crosstalk
~/.local/share/crosstalk/bin/crosstalk install agy      # Antigravity
~/.local/share/crosstalk/bin/crosstalk install kimi     # Kimi Code
~/.local/share/crosstalk/bin/crosstalk install hermes   # Hermes
```

Nothing is downloaded or built at install time beyond the clone itself.

## 4. Verify

| Agent | Run | Expect |
|---|---|---|
| Claude Code | `claude plugin list` | `crosstalk@epode`, enabled |
| Antigravity, Kimi Code, Hermes | `<clone>/bin/crosstalk doctor` | no line marked `✗` |
| Codex, Cursor, Qwen Code, Goose | the install command's own output | it says crosstalk was added or installed |

If it did not work, report the command's output to the person rather than
trying other commands. In the next session they open, the tools are there:
`crosstalk_people action "peers"` answers.

## 5. Tell the person

Say, in one or two sentences: crosstalk is installed for <agent>; it starts in
the next session they open (the current one does not have its hooks yet); and,
for Codex and Cursor, the one step only they can do. Nothing else to configure:
no account, no key, no server.

## Teammates

In a repository whose `.claude/settings.json` already enables crosstalk
(`"enabledPlugins": { "crosstalk@epode": true }` with the `epode` marketplace
in `extraKnownMarketplaces`), Claude Code offers it to everyone who opens the
repo once they trust the folder. There is nothing to install: if you see that
in the repo you are working in, tell the person so instead of installing.

## Anything else

Any other client that speaks MCP gets the tools, without hooks, untested. Point
it at a clone:

```
command: <clone>/bin/crosstalk
args:    ["server"]
```
