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
import { agentAsks, agentLine, ago, dotFor, featureLine, fileLink, historyLine, cleanRecap, inboxChoices, inboxMail, inboxRow, inboxSections, inboxUrgent, linkable, withoutThread, noteLine, prGroups, prName, prWhy, runningGroups, runningLine, runningWhere } from '../src/ui-extra/pure.ts'

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
 * The inbox, as a tracker's list: sections (blocked on you, questions, messages),
 * each a header with its count, then one line per thing: who from, its kind's dot,
 * what it is, and how long it has waited. Arrows move, Enter opens one in place:
 * its words, its choices on 1 to 4, s to snooze, e to mark a message done.
 */
export const TONE: Record<string, string> = { blue: 'blue', yellow: 'yellow', red: 'error', green: 'green', gray: 'gray' }

export function inboxTree(E: Els, rows: Item[], openId: string | undefined, now: number, on: InboxActions) {
  const { Box, Text, Button } = E
  if (!rows.length)
    return (
      <Box flexDirection="column">
        <Text bold>Inbox</Text>
        <Text dimColor>  Nothing needs you.</Text>
      </Box>
    )
  let first = true
  return (
    <Box flexDirection="column">
      {inboxSections(rows as any[]).map((g, gi) => (
        <Box key={`sec:${g.key}`} flexDirection="column" marginTop={gi ? 1 : 0}>
          <Text>
            <Text color={TONE[g.tone]}>◉</Text> <Text bold>{g.title}</Text> <Text dimColor>{g.items.length}</Text>
          </Text>
          {g.items.map((it: Item) => {
            const m = inboxMail(it as any, now)
            const isOpen = it.id === openId
            const focus = first
            first = false
            const context = clean((it.kind === 'message' || it.kind === 'ask' ? '' : (it.text ?? '')).trim()).slice(0, 420)
            const who = clean(m.sender).slice(0, 12).padEnd(12)
            const line = [
              <Text key="w" dimColor>
                {'  '}
                {who}{' '}
              </Text>,
              <Text key="d" color={TONE[m.tone]}>
                ●
              </Text>,
              <Text key="s" bold={m.unread || isOpen} dimColor={!m.unread && !isOpen}>
                {' '}
                {clean(m.subject)}
              </Text>,
            ]
            return (
              <Box key={`box:${it.id}`} flexDirection="column">
                <Box flexDirection="row" justifyContent="space-between">
                  {Button ? (
                    <Button key={`row:${it.id}`} plain onPress={() => on.open(isOpen ? '' : it.id)} {...(focus ? { autoFocus: true } : {})}>
                      <Text wrap="truncate">{line}</Text>
                    </Button>
                  ) : (
                    <Text wrap="truncate">{line}</Text>
                  )}
                  <Text dimColor> {m.time}</Text>
                </Box>
                {isOpen ? (
                  <Box flexDirection="column" marginLeft={16} marginBottom={1}>
                    <Text dimColor wrap="truncate">
                      {m.chip}
                      {it.thread ? ` · ${clean(it.thread)}` : ''}
                    </Text>
                    {it.kind === 'message' || it.kind === 'ask' ? (
                      <Text wrap="wrap">{clean(it.text ?? '').slice(0, 600)}</Text>
                    ) : context ? (
                      <Text wrap="wrap">{context}</Text>
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
      ))}
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
type PaneOn = { agent?: (sessionId: string) => void; back?: () => void; more?: () => void; expanded?: boolean; fixPr?: (url: string) => void; openUrl?: (url: string) => void }

/**
 * Pull requests by what the person can do: failing ones (Enter hands the fix to an
 * agent), ready ones (Enter opens it to review and merge), and a count of the rest,
 * which need nothing yet. Every row that can be acted on is a button.
 */
function prBlock(E: Els, prs: readonly any[], on: PaneOn, key: string, thread?: string) {
  const { Box, Text, Button } = E
  const g = prGroups((prs as any[]).map(r => ({ ...r, label: thread ? withoutThread(r.label, thread) : r.label })))
  const row = (r: any, i: number, kind: 'fix' | 'ready') => {
    const text = `${prName(r)} · ${prWhy(r)}`
    const press = kind === 'fix' ? on.fixPr : on.openUrl
    return Button && press && r.url ? (
      <Button key={`${key}${kind}${i}`} plain onPress={() => press(r.url)}>
        <Text wrap="truncate">
          {'  '}
          <Text color={kind === 'fix' ? 'error' : 'green'}>●</Text> {clean(text)}
        </Text>
      </Button>
    ) : (
      <Text key={`${key}${kind}${i}`} wrap="truncate" color={kind === 'fix' ? BROKEN : undefined}>
        {'  '}
        {clean(text)}
      </Text>
    )
  }
  return [
    g.fix.length ? (
      <Box key={`${key}f`} flexDirection="column" marginTop={1}>
        <Text>
          <Text color="error">◉</Text> <Text bold>Checks failed</Text> <Text dimColor>{g.fix.length} · Enter hands one to an agent</Text>
        </Text>
        {g.fix.map((r, i) => row(r, i, 'fix'))}
      </Box>
    ) : null,
    g.ready.length ? (
      <Box key={`${key}r`} flexDirection="column" marginTop={1}>
        <Text>
          <Text color="green">◉</Text> <Text bold>Ready to review</Text> <Text dimColor>{g.ready.length} · Enter opens it</Text>
        </Text>
        {g.ready.map((r, i) => row(r, i, 'ready'))}
      </Box>
    ) : null,
    g.rest.length ? (
      <Box key={`${key}x`} flexDirection="column" marginTop={on.expanded || !(g.fix.length || g.ready.length) ? 1 : 0}>
        {on.expanded ? (
          [<Text key={`${key}xh`} bold>Other pull requests</Text>, ...g.rest.map((r: any, i: number) => (
            <Text key={`${key}x${i}`} wrap="truncate" dimColor>
              {'  '}
              {clean(`${prName(r)} · ${prWhy(r)}`)}
            </Text>
          ))]
        ) : (
          <Text dimColor wrap="truncate">
            {' '}
            {g.rest.length === 1 ? '1 other pull request needs' : `${g.rest.length} other pull requests need`} nothing from you yet
          </Text>
        )}
      </Box>
    ) : null,
  ]
}

export function paneTree(E: Els, p: Pane | null, problem: string, now: number, inbox?: any, on: PaneOn = {}) {
  const { Box, Text, Link, Button } = E
  if (!p)
    return (
      <Box flexDirection="column">
        <Text dimColor>{clean(problem || 'loading…')}</Text>
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
            <Text>
              <Text color="gray">◉</Text> <Text bold>Sessions</Text> <Text dimColor>{p.agents.length} · Enter opens one</Text>
            </Text>
            {p.agents.map((a, i) =>
              Button && on.agent && a.sessionId ? (
                <Button key={`agent:${a.sessionId}`} plain onPress={() => on.agent!(a.sessionId!)}>
                  <Text wrap="truncate">
                    {'  '}
                    {clean(agentLine(a))}
                  </Text>
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
        {p.prs?.length ? prBlock(E, p.prs, on, 'mp') : null}
        {p.events?.length ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>What happened</Text>
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
        // For the phone (crosstalk_work action "qr"): white on black, so it scans on any terminal theme. Never model context.
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
      {p.waiting.length ? section('Needs you', p.waiting.map(w => `? ${w}`), 'w') : null}
      {prBlock(E, (p.running ?? []).filter(r => r.kind === 'pr'), on, 'tp', p.thread)}
      {/* What is open and what was decided; the rest of a thread's detail waits behind "more". */}
      {p.notes?.length ? section('Notes', p.notes.filter(n => on.expanded || n.kind === 'decision' || (n.kind === 'task' && n.state !== 'done')).slice(0, on.expanded ? 99 : 5).map(n => noteLine(n, now)), 'n') : null}
      {on.expanded && p.features.length ? section('Features', p.features.map(featureLine), 'f') : null}
      {p.running?.some(r => r.kind !== 'pr' && (on.expanded || r.kind === 'server' || r.kind === 'preview')) ? (
        <Box key="r" flexDirection="column" marginTop={1}>
          <Text bold>
            Running {Button && on.openUrl ? <Text dimColor>· Enter opens one</Text> : null}
          </Text>
          {runningGroups(p.running.filter(r => r.kind !== 'pr' && (on.expanded || r.kind === 'server' || r.kind === 'preview'))).map(g => (
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
                ) : Button && on.openUrl && (r.kind === 'server' || r.kind === 'preview') && r.alive && runningWhere(r) ? (
                  <Button key={`r${g.kind}${i}`} plain onPress={() => on.openUrl!(r.url ?? `http://${runningWhere(r)}`)}>
                    {'  '}
                    {clean(runningLine({ ...r, label: withoutThread(r.label, p.thread) }, now))} {clean(runningWhere(r))}
                  </Button>
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
      {on.expanded && p.recent.length ? section('Recent', p.recent.map(r => `${r.from} ${ago(r.ts, now)} ${r.text}`), 'm') : null}
      {on.expanded && p.history?.length ? section('History', p.history.map(h => historyLine(h, now)), 'h') : null}
      {Button && on.more && !on.expanded && (p.features.length || p.recent.length || p.history?.length || p.running?.some(r => r.kind !== 'server' && r.kind !== 'preview' && (r.kind !== 'pr' || !['failed', 'passed'].includes(r.checks ?? ''))) || (p.notes?.length ?? 0) > 5) ? (
        <Box marginTop={1}>
          <Button key="more" plain dimColor hotkey="m" onPress={on.more}>
            more: features, other pull requests, recent messages, history, links
          </Button>
        </Box>
      ) : null}
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
      return row('work', 'which work is this part of?')
    case 'rule':
      return row('rule', 'always answer this way?')
    case 'disk':
      return row('disk', 'free disk from finished work?')
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
