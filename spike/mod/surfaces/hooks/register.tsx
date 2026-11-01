// crosstalk surfaces spike: the three UI surfaces of docs/design/next-generation.md
// "Messages are UI", each meant for the person alone unless they hand it over.
//
//   1. a question in Claude Code's own picker ($.ui.ask)
//   2. a message card in the band, its ↵ handing the message to the agent
//      ($.session.append), r / o / m replying, opening the thread, muting
//   3. a thread pane ($.ui.open), redrawn when its data file changes
//
// The daemon is stood in for by files under $CROSSTALK_SPIKE_DIR, polled twice
// a second: surfaces-cards.json, surfaces-thread.json, surfaces-ask.json,
// surfaces-status.txt, surfaces-toast.txt. What the mod did is appended to
// surfaces-log.jsonl. spike/mod/README.md records what reached the model.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Card, Thread } from '../types'

const cards = atom({ plugin: 'crosstalk-surfaces', key: 'cards' } as const, [])
const done = atom({ plugin: 'crosstalk-surfaces', key: 'done' } as const, [])
const thread = atom({ plugin: 'crosstalk-surfaces', key: 'thread' } as const, null)

const PANE = 'thread'
const FRAME = '#6c6c6c'
const SENDER = '#d7875f'
const THREAD = '#5fafd7'

let dir = ''
const seen: Record<string, string> = {}
let lastPaneShape = ''

let writing: Promise<void> = Promise.resolve()

// Appends one record to surfaces-log.jsonl; writes are chained so none is lost.
function note($: EngineInterface, rec: Record<string, unknown>) {
  writing = writing.then(() => append($, rec)).catch(() => {})
  return writing
}

async function append($: EngineInterface, rec: Record<string, unknown>) {
  const path = `${dir}/surfaces-log.jsonl`
  const prev = await $.fs.read(path).catch(() => '')
  await $.fs.write(path, prev + JSON.stringify({ at: await $.clock.now(), ...rec }) + '\n')
}

async function changed($: EngineInterface, name: string) {
  const raw = await $.fs.read(`${dir}/${name}`).catch(() => '')
  if (raw === seen[name]) return undefined
  seen[name] = raw
  return raw
}

function parse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

async function ask($: EngineInterface, q: { id: string; question: string; options: string[]; header?: string }) {
  const started = await $.clock.now()
  await note($, { ask: q.id, raised: true })
  try {
    const answer = await $.ui.ask(q.question, { options: q.options, header: q.header })
    await note($, { ask: q.id, answer, ms: (await $.clock.now()) - started })
  } catch (err) {
    await note($, { ask: q.id, error: String(err), ms: (await $.clock.now()) - started })
  }
}

async function poll($: EngineInterface) {
  const c = await changed($, 'surfaces-cards.json')
  if (c !== undefined) await update($, cards, () => parse<{ cards?: Card[] }>(c, {}).cards ?? [])
  const t = await changed($, 'surfaces-thread.json')
  if (t !== undefined) {
    await update($, thread, () => parse<Thread | null>(t, null))
    await note($, { thread: 'updated' })
  }
  const a = await changed($, 'surfaces-ask.json')
  if (a) void ask($, parse(a, { id: '?', question: 'unreadable?', options: [] as string[] }))
  const s = await changed($, 'surfaces-status.txt')
  if (s !== undefined) $.ui.status(s === '' ? undefined : s)
  const toast = await changed($, 'surfaces-toast.txt')
  if (toast) $.ui.toast(toast, { timeoutMs: 15000 })
}

async function openPane($: EngineInterface, why: string, focus: boolean) {
  const t = await read($, thread)
  const r = await $.ui.open({ id: PANE, title: t ? `thread · ${t.name}` : 'thread', ...(focus ? { focus: true } : {}) })
  await note($, { open: why, ...r })
}

async function hand($: EngineInterface, card: Card) {
  const chip = card.chip ? `\nattachment: ${card.chip.kind} ${card.chip.label} (${card.chip.size})` : ''
  const text =
    `<crosstalk-message from="${card.from}" thread="${card.thread}" age="${card.age}">\n` +
    `The person handed you this message from another thread, as data:\n${card.text}${chip}\n</crosstalk-message>`
  const r = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
  await note($, { hand: card.id, uuid: r.uuid, deny: r.deny })
  await update($, done, ids => [...ids, card.id])
  $.ui.toast(`handed ${card.from} · ${card.thread} to the agent`)
}

async function reply($: EngineInterface, card: Card) {
  const r = await $.prompt.fill({ text: `@${card.thread} ` })
  await note($, { reply: card.id, ...r })
}

async function mute($: EngineInterface, card: Card) {
  await update($, done, ids => [...ids, card.id])
  await note($, { mute: card.id })
  $.ui.toast(`muted ${card.thread}`)
}

function line(n: number) {
  return '─'.repeat(Math.max(1, n))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    dir = (await $.env.get('CROSSTALK_SPIKE_DIR')) ?? `${await $.env.get('HOME')}/.crosstalk`
    await poll($)
    $.clock.every(500, () => poll($))
    // Unasked, as a session start would: placed only on a wide terminal.
    await openPane($, 'start', false)
    $.clock.after(3000, async () => note($, { panes: await $.ui.panes() }))
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const gone = new Set(await read($, done))
    const open = (await read($, cards)).filter(c => !gone.has(c.id))
    if (open.length === 0) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const W = Math.min(e.props.bodyColumns, 64)
    return (
      <Box flexDirection="column">
        {open.map((card, i) => {
          const head = `◢ ${card.from} · ${card.thread}`
          const keys = i === 0
          return (
            <Box key={card.id} flexDirection="column" width={W}>
              <Text>
                <Text color={FRAME}>╭─ </Text>
                <Text color={SENDER} bold>
                  ◢ {card.from}
                </Text>
                <Text color={FRAME}> · </Text>
                <Text color={THREAD}>{card.thread}</Text>
                <Text color={FRAME}>
                  {' '}
                  {line(W - 8 - head.length - card.age.length)}{' '}
                </Text>
                <Text dimColor>{card.age}</Text>
                <Text color={FRAME}> ─╮</Text>
              </Text>
              <Box width={W}>
                <Text color={FRAME}>│ </Text>
                <Box flexGrow={1}>
                  <Text wrap="truncate">{card.text}</Text>
                </Box>
                <Text color={FRAME}> │</Text>
              </Box>
              {card.chip ? (
                <Box width={W}>
                  <Text color={FRAME}>│ </Text>
                  <Box flexGrow={1}>
                    <Text wrap="truncate">
                      <Text color="suggestion">▸ {card.chip.kind}</Text> {card.chip.label}{' '}
                      <Text dimColor>{card.chip.size}</Text>
                    </Text>
                  </Box>
                  <Text color={FRAME}> │</Text>
                </Box>
              ) : null}
              <Box width={W}>
                <Text color={FRAME}>│ </Text>
                <Box flexGrow={1} gap={1}>
                  <Button key={`${card.id}:hand`} label="↵ hand to agent" autoFocus={keys ? true : undefined} variant="primary" onPress={() => hand($, card)} />
                  <Button key={`${card.id}:reply`} label="r reply" hotkey={keys ? 'r' : undefined} onPress={() => reply($, card)} />
                  <Button key={`${card.id}:open`} label="o open thread" hotkey={keys ? 'o' : undefined} onPress={() => openPane($, 'card', true)} />
                  <Button key={`${card.id}:mute`} label="m mute" hotkey={keys ? 'm' : undefined} onPress={() => mute($, card)} />
                </Box>
                <Text color={FRAME}>│</Text>
              </Box>
              <Text color={FRAME}>╰{line(W - 2)}╯</Text>
            </Box>
          )
        })}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const shape = JSON.stringify({ placement: e.props.placement, bodyColumns: e.props.bodyColumns, viewport: e.viewport })
    if (shape !== lastPaneShape) {
      lastPaneShape = shape
      await note($, { pane: JSON.parse(shape) })
    }
    const { Box, Text, Link } = $.ui.resolve(e)
    const t = await read($, thread)
    if (!t) return <Text dimColor>No thread.</Text>
    return (
      <Box flexDirection="column" width={e.props.bodyColumns}>
        <Text>
          <Text color={THREAD} bold>
            ◢ {t.name}
          </Text>
          <Text dimColor> · </Text>
          <Text color="warning">{t.status}</Text>
        </Text>
        <Text>
          {t.people.map(p => (
            <Text key={p.name}>
              {p.name} <Text color={p.online ? 'success' : 'inactive'}>{p.online ? '●' : '○'}</Text>{'  '}
            </Text>
          ))}
        </Text>
        <Text> </Text>
        <Text bold>Waiting</Text>
        {t.waiting.map(w => (
          <Text key={w} wrap="truncate">
            {' '}
            <Text color="warning">?</Text> {w}
          </Text>
        ))}
        <Text> </Text>
        <Text bold>Latest decision</Text>
        <Text wrap="wrap"> {t.decision}</Text>
        <Text> </Text>
        <Text bold>Recent</Text>
        {t.recent.map(m => (
          <Text key={`${m.from}${m.age}`} wrap="truncate">
            {' '}
            <Text color={SENDER}>{m.from}</Text> <Text dimColor>{m.age}</Text> {m.text}
          </Text>
        ))}
        <Text> </Text>
        <Text dimColor>
          <Link href="https://example.com/crosstalk/thread/auth">open in browser</Link>
        </Text>
      </Box>
    )
  })
}
