// What crosstalk's mod draws, as trees over the surface's element table: the
// thread pane and the band above the prompt. register.tsx's render hooks call
// these with `$.ui.resolve(e)`; test/snapshots/ draws the same trees to text
// frames and compares them with the stored snapshots.
//
// Colours are theme keys, so the pane and the cards follow the person's light
// or dark theme: `inactive` for frames, `claude` for a sender, `suggestion`
// for a thread, `error` for something broken. The QR code alone is raw white
// on black, so it scans on any theme. No hook, state or I/O in here.

import type { Item, Pane } from './types'
import { agentAsks, agentLine, ago, dotFor, featureLine, fileLink, historyLine, cleanRecap, inboxChoices, inboxRow, inboxUrgent, linkable, withoutThread, noteLine, runningGroups, runningLine, runningWhere } from '../src/ui-extra/pure.ts'

/** The elements these trees are made of: the surface's own Box, Text and Link, and Button where a tree takes presses. */
export type Els = { Box: any; Text: any; Link: any; Button?: any }

/** What the inbox's presses do: register.tsx answers them through the same paths as its pickers. */
export type InboxActions = {
  open: (id: string) => void
  choose: (it: Item, choice: string) => void
  snooze: (it: Item) => void
  done: (it: Item) => void
}

/**
 * The inbox, as Linear's: one row per thing waiting on the person, most pressing
 * first, each its kind, what it is, where it is from and how long it has waited.
 * Arrows move, Enter opens a row in place: its context, its choices on 1 to 4,
 * s to snooze it and e to mark it done. The first row is open to begin with.
 */
export function inboxTree(E: Els, rows: Item[], openId: string | undefined, now: number, on: InboxActions) {
  const { Box, Text, Button } = E
  if (!rows.length)
    return (
      <Box flexDirection="column">
        <Text bold>Inbox</Text>
        <Text dimColor> Nothing needs you.</Text>
      </Box>
    )
  const openKey = (rows.find(r => r.id === openId) ?? rows[0])?.id
  return (
    <Box flexDirection="column">
      <Text bold>
        Inbox <Text dimColor>· {rows.length}</Text>
      </Text>
      {rows.map((it, i) => {
        const r = inboxRow(it as any, now)
        const isOpen = it.id === openKey
        const context = clean((it.kind === 'message' || it.kind === 'ask' ? '' : (it.text ?? '')).trim()).slice(0, 420)
        return (
          <Box key={`box:${it.id}`} flexDirection="column" marginTop={isOpen && i > 0 ? 1 : 0}>
            {Button ? (
              <Button key={`row:${it.id}`} plain onPress={() => on.open(it.id)} {...(i === 0 ? { autoFocus: true } : {})}>
                {isOpen ? '▸ ' : '  '}
                {r.glyph} {isOpen ? <Text bold>{clean(r.title)}</Text> : clean(r.title)} <Text dimColor>{clean(r.meta)}</Text>
              </Button>
            ) : (
              <Text wrap="truncate">
                {isOpen ? '▸ ' : '  '}
                {r.glyph} {clean(r.title)} <Text dimColor>{clean(r.meta)}</Text>
              </Text>
            )}
            {isOpen ? (
              <Box flexDirection="column" marginLeft={4} marginBottom={1}>
                {it.kind === 'message' || it.kind === 'ask' ? (
                  <Text wrap="wrap">{clean(it.text ?? '').slice(0, 420)}</Text>
                ) : r.title !== clean(it.question ?? '') && it.question ? (
                  <Text wrap="wrap">{clean(it.question)}</Text>
                ) : null}
                {context ? (
                  <Text dimColor wrap="wrap">
                    {context}
                  </Text>
                ) : null}
                {Button ? (
                  <Box flexDirection="row" flexWrap="wrap">
                    {inboxChoices(it as any).flatMap((c, n) => [
                      <Button key={`choice:${it.id}:${n}`} plain hotkey={String(n + 1)} onPress={() => on.choose(it, c)}>
                        {clean(c)}
                      </Button>,
                      <Text key={`gap:${it.id}:${n}`}>{'   '}</Text>,
                    ])}
                    {/* Snooze only what has no deadline: a permission or an agent's question waits on you, and goes its own way when its time runs out. */}
                    {!inboxUrgent(it) ? (
                      <Button key={`snooze:${it.id}`} plain dimColor hotkey="s" onPress={() => on.snooze(it)}>
                        snooze
                      </Button>
                    ) : null}
                    {!inboxUrgent(it) ? <Text key={`gap:${it.id}:s`}>{'   '}</Text> : null}
                    {/* Done only dismisses a message: on a question it would quietly answer it (a permission's Deny). */}
                    {it.kind === 'message' || it.kind === 'ask' ? (
                      <Button key={`done:${it.id}`} plain dimColor hotkey="e" onPress={() => on.done(it)}>
                        done
                      </Button>
                    ) : null}
                  </Box>
                ) : null}
              </Box>
            ) : null}
          </Box>
        )
      })}
    </Box>
  )
}

export const FRAME = 'inactive'
export const SENDER = 'claude'
export const THREAD = 'suggestion'
export const BROKEN = 'error'
export const CARD_MAX = 64

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
/** A text child takes no control characters. */
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, ' ')

function age(ts: number | undefined, now: number): string {
  if (!ts) return ''
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

function size(bytes: number | undefined): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * The thread pane: status and people, the recap, a QR code when one is up,
 * what is waiting, then Notes, Features, Running (by kind), recent messages
 * and History. `problem`: what the pane could not show.
 */
export function paneTree(E: Els, p: Pane | null, problem: string, now: number, inbox?: any, on: { agent?: (sessionId: string) => void; back?: () => void } = {}) {
  const { Box, Text, Link, Button } = E
  if (!p)
    return (
      <Box flexDirection="column">
        <Text dimColor>{clean(problem || 'loading the thread…')}</Text>
      </Box>
    )
  // Every agent ("show me all my agents", and the main session's pane): waiting on you first, then working, then idle.
  if (p.agents)
    return (
      <Box flexDirection="column">
        <Text wrap="truncate">
          <Text color={THREAD} bold>
            ◢ {clean(p.thread)}
          </Text>
          <Text dimColor> · {clean(p.status)}</Text>
        </Text>
        {inbox ? (
          <Box flexDirection="column" marginTop={1}>
            {inbox}
          </Box>
        ) : (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Needs you{p.inbox?.length ? ` · ${p.inbox.length}` : ''}</Text>
            {p.inbox?.length ? (
              p.inbox.map((l, i) => (
                <Text key={`i${i}`} wrap="truncate" bold={i === 0}>
                  {' '}
                  {i + 1}. {clean(l)}
                </Text>
              ))
            ) : (
              <Text dimColor> nothing right now</Text>
            )}
          </Box>
        )}
        {p.agents.length ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>
              Sessions · {p.agents.length} <Text dimColor>· Enter opens one</Text>
            </Text>
            {p.agents.map((a, i) =>
              Button && on.agent && a.sessionId ? (
                <Button key={`agent:${a.sessionId}`} plain onPress={() => on.agent!(a.sessionId!)}>
                  {' '}
                  {clean(agentLine(a))}
                </Button>
              ) : (
                <Text key={`a${i}`} wrap="truncate">
                  {' '}
                  {clean(agentLine(a))}
                </Text>
              ),
            )}
          </Box>
        ) : null}
        {p.prs?.length ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Pull requests</Text>
            {p.prs.map((r, i) => (
              <Text key={`p${i}`} wrap="truncate">
                {' '}
                {r.checks === 'failed' ? <Text color={BROKEN}>{clean(runningLine(r, now))}</Text> : clean(runningLine(r, now))}
                {r.url && linkable(r.url) ? ' ' : ''}
                {r.url && linkable(r.url) ? <Link href={r.url}>open</Link> : null}
              </Text>
            ))}
          </Box>
        ) : null}
        {p.events?.length ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Lately</Text>
            {p.events.map((e, i) => (
              <Text key={`e${i}`} wrap="truncate" dimColor>
                {' '}
                {clean(e.text)} · {ago(e.at, now)}
              </Text>
            ))}
          </Box>
        ) : null}
        {p.idle || p.usage ? (
          <Box marginTop={1}>
            <Text wrap="truncate" dimColor={!p.usage?.hot}>
              {[p.idle ? `${p.idle} idle` : '', p.usage ? p.usage.text : ''].filter(Boolean).join(' · ')}
            </Text>
          </Box>
        ) : null}
      </Box>
    )
  const section = (title: string, rows: string[], key: string) => (
    <Box key={key} flexDirection="column" marginTop={1}>
      <Text bold>{title}</Text>
      {rows.map((r, i) => (
        <Text key={`${key}${i}`} wrap="truncate">
          {' '}
          {clean(r)}
        </Text>
      ))}
    </Box>
  )
  const link = (url: string) => (linkable(url) ? <Link href={url}>{url}</Link> : clean(url))
  return (
    <Box flexDirection="column">
      {Button && on.back ? (
        <Box marginBottom={1}>
          <Button key="back" plain hotkey="b" autoFocus onPress={on.back}>
            ◂ back to your inbox
          </Button>
        </Box>
      ) : null}
      <Text wrap="truncate">
        <Text color={THREAD} bold>
          {p.thread ? dotFor(p.thread) : '◢'} {clean(p.thread)}
        </Text>
        <Text dimColor> · {clean(p.status)}{p.sessions ? ` · ${p.sessions} working` : ''}</Text>
      </Text>
      <Text wrap="truncate">{clean(p.people.join('  ') || 'nobody yet')}</Text>
      {p.recap && cleanRecap(p.recap) ? (
        <Text dimColor wrap="wrap">
          {clean(cleanRecap(p.recap))}
        </Text>
      ) : null}
      {p.qr ? (
        // For the phone (crosstalk_look action "qr"): white on black, so it scans on any terminal theme. Never model context.
        <Box key="q" flexDirection="column" marginTop={1}>
          <Text bold wrap="truncate">On your phone · {clean(p.qr.label)}</Text>
          {p.qr.rows.map((r, i) => (
            <Text key={`q${i}`} color="#ffffff" backgroundColor="#000000" wrap="truncate">
              {r}
            </Text>
          ))}
          <Text dimColor wrap="truncate">{clean(p.qr.caption)}</Text>
          {p.qr.why ? <Text dimColor wrap="wrap">{clean(p.qr.why)}</Text> : null}
        </Box>
      ) : null}
      {section('Needs you', p.waiting.length ? p.waiting.map(w => `? ${w}`) : ['nothing'], 'w')}
      {p.notes?.length ? section('Notes', p.notes.map(n => noteLine(n, now)), 'n') : null}
      {p.features.length ? section('Features', p.features.map(featureLine), 'f') : null}
      {p.running?.length ? (
        <Box key="r" flexDirection="column" marginTop={1}>
          <Text bold>Running</Text>
          {runningGroups(p.running).map(g => (
            <Box key={`r${g.kind}`} flexDirection="column">
              <Text dimColor> {g.title}</Text>
              {g.items.map((r, i) =>
                r.kind === 'screenshot' ? (
                  // A mod cannot draw an image: each before and after is a file link (OSC 8) to open it.
                  <Box key={`r${g.kind}${i}`} flexDirection="column">
                    <Text wrap="truncate">
                      {'  '}
                      {clean(runningLine(r, now))}
                    </Text>
                    {[...(r.before ? [{ w: 'before', f: r.before.file }] : []), ...(r.after ? [{ w: 'after ', f: r.after.file }] : [])].map(({ w, f }) => {
                      const href = fileLink(f)
                      return (
                        <Text key={`r${g.kind}${i}${w}`} wrap="truncate" dimColor>
                          {'   '}
                          {w} {href ? <Link href={href}>{clean(f)}</Link> : clean(f)}
                        </Text>
                      )
                    })}
                  </Box>
                ) : (
                  <Text key={`r${g.kind}${i}`} wrap="truncate" dimColor={!r.alive}>
                    {'  '}
                    {r.broken ? <Text color={BROKEN}>{clean(runningLine({ ...r, label: withoutThread(r.label, p.thread) }, now))}</Text> : clean(runningLine({ ...r, label: withoutThread(r.label, p.thread) }, now))}
                    {runningWhere(r) ? ' ' : ''}
                    {runningWhere(r) ? link(r.url ?? `http://${runningWhere(r)}`) : null}
                  </Text>
                ),
              )}
            </Box>
          ))}
        </Box>
      ) : null}
      {p.recent.length ? section('Recent', p.recent.map(r => `${r.from} ${ago(r.ts, now)} ${r.text}`), 'm') : null}
      {p.history?.length ? section('History', p.history.map(h => historyLine(h, now)), 'h') : null}
      {problem ? <Text dimColor>{clean(problem)}</Text> : null}
    </Box>
  )
}

/** One line in the band for a question crosstalk asks (not a message): `◢ ship · auth: merge it?`. */
function questionRow(E: Els, it: Item, later: string) {
  const { Text } = E
  const row = (head: string, rest: string) => (
    <Text key={it.id} wrap="truncate">
      <Text color={THREAD} bold>◢ {head}</Text>
      <Text dimColor>
        {' '}
        · {rest}
        {later}
      </Text>
    </Text>
  )
  switch (it.kind) {
    case 'invite':
      return (
        <Text key={it.id} wrap="truncate">
          <Text color={THREAD} bold>◢ invite</Text>
          <Text> {it.text ?? ''}</Text>
          <Text dimColor> · read the words to them; they work once, for fifteen minutes</Text>
        </Text>
      )
    case 'doctor':
      return row('crosstalk', cut(oneLine((it.question ?? 'something is wrong').replace(/^crosstalk found /, 'found ')), 140))
    case 'restore':
      return row('restore', `${it.count ?? 0} agent${it.count === 1 ? '' : 's'} to bring back · or say "restore them"`)
    case 'gather':
      return row('gather', `${it.count ?? 0} agent${it.count === 1 ? '' : 's'} without crosstalk · or say "bring them in"`)
    case 'team':
      return row('team', `${it.from}'s key changed and is not trusted yet`)
    case 'cleanup':
      return row('clean up', `${it.count ?? 0} finished cop${it.count === 1 ? 'y' : 'ies'} of the code · or say "clean them up"`)
    case 'ship':
      return row('ship', `${it.thread ? `${it.thread}: ` : ''}${cut(oneLine(it.question ?? 'a question for you'), 90)}`)
    case 'thread':
      return row('thread', 'which thread is this part of?')
    case 'rule':
      return row('rule', 'always answer this way?')
    case 'disk':
      return row('disk', 'free disk from finished threads?')
    case 'install':
      return row('install', `turn crosstalk on for everyone in ${it.thread ?? 'this repo'}?`)
    case 'connect':
      return row('connect', `connect with your team in ${it.thread ?? 'this repo'}?`)
    case 'conflict':
      return row('conflict', `who changes ${it.thread ?? 'it'}?`)
    case 'attention':
      return row(it.from ?? it.thread ?? 'crosstalk', cut(oneLine(it.question ?? 'a question for you'), 90))
    case 'route':
      return row('route', `a message from ${it.from} needs an agent`)
  }
  return null
}

/** A message card: sender and thread in the frame, the text, a chip per attachment. */
function card(E: Els, it: Item, W: number, now: number, later: string) {
  const { Box, Text } = E
  const head = `${it.thread ? dotFor(it.thread) : '◢'} ${it.from} · ${it.thread ?? 'crosstalk'}`
  const a = age(it.ts, now)
  const fill = Math.max(1, W - 7 - head.length - a.length)
  const body = (key: string, child: unknown) => (
    <Box key={key} width={W}>
      <Text color={FRAME}>│ </Text>
      <Box flexGrow={1}>{child}</Box>
      <Text color={FRAME}> │</Text>
    </Box>
  )
  return (
    <Box key={it.id} flexDirection="column" width={W}>
      <Text>
        <Text color={FRAME}>╭─ </Text>
        <Text color={SENDER} bold>◢ {it.from}</Text>
        <Text color={FRAME}> · </Text>
        <Text color={THREAD}>{it.thread ?? 'crosstalk'}</Text>
        <Text color={FRAME}> {'─'.repeat(fill)} </Text>
        <Text dimColor>{a}</Text>
        <Text color={FRAME}>─╮</Text>
      </Text>
      {body(
        `${it.id}:text`,
        <Text wrap="truncate">
          {it.kind === 'ask' ? '? ' : ''}
          {oneLine(it.text ?? '')}
        </Text>,
      )}
      {(it.chips ?? []).map((c, i) =>
        body(
          `${it.id}:chip${i}`,
          <Text wrap="truncate">
            <Text color="suggestion">▸ {c.kind}</Text> {c.label} <Text dimColor>{size(c.bytes)}</Text>
          </Text>,
        ),
      )}
      {later
        ? body(
            `${it.id}:later`,
            <Text dimColor wrap="truncate">
              asks after your next message
            </Text>,
          )
        : null}
      <Text color={FRAME}>╰{'─'.repeat(W - 2)}╯</Text>
    </Box>
  )
}

/**
 * The band above the prompt: the digest's line at a pause, then each thing
 * waiting, a question as one line and a message as a card. `raisable` says
 * whether its picker comes up now or after the person's next turn.
 */
export function bandTree(E: Els, open: Item[], digest: string, now: number, bodyColumns: number, raisable: (it: Item) => boolean) {
  const { Box, Text } = E
  const W = Math.max(24, Math.min(bodyColumns, CARD_MAX))
  const later = (it: Item) => (raisable(it) ? '' : ' · asks after your next message')
  // Calm: never a wall. Nothing empty, nothing stale (a day old and not blocking), no open-list leftovers;
  // at most two shown, the rest counted.
  const DAY = 86_400_000
  const keep = open.filter(
    it =>
      !it.id.startsWith('open:') &&
      !it.id.startsWith('tackle:') &&
      !((it.kind === 'message' || it.kind === 'ask') && !(it.text ?? '').trim()) &&
      (now - (it.ts ?? it.createdAt) < DAY || it.id.startsWith('relay:') || it.id.startsWith('attn:perm:') || it.kind === 'ask'),
  )
  const shown = keep.slice(0, 2)
  const more = keep.length - shown.length
  return (
    <Box flexDirection="column">
      {digest ? (
        <Text key="digest" wrap="truncate" dimColor>
          {clean(digest)}
        </Text>
      ) : null}
      {shown.map(it => (it.kind === 'message' || it.kind === 'ask' ? card(E, it, W, now, later(it)) : questionRow(E, it, later(it)) ?? card(E, it, W, now, later(it))))}
      {more > 0 ? (
        <Text key="more" wrap="truncate" dimColor>
          {'  '}and {more} more, one at a time
        </Text>
      ) : null}
    </Box>
  )
}
