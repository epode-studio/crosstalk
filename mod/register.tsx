// crosstalk's mod: everything crosstalk shows a person, as Claude Code's own UI,
// kept out of the model until the person hands something over.
//
//   a message      a card in the band above the prompt, then the picker:
//                  Hand to agent / Reply / Mute / Later
//   a question     a peer's crosstalk ask: Answer / Hand to agent / Later / Mute
//   a route        "which session gets ben's message?": the sessions, and Hold it
//   restore        "Restore 6 sessions?": Restore / Open as windows / Not now
//   gather         "4 Claude sessions started before crosstalk. Bring them in?":
//                  Bring them in / Not now, and a toast once they are in
//   status line    ◢ <threads or repo> · <n> waiting
//
// The mod keeps nothing that matters. What is waiting, and what became of it,
// is crosstalk's (src/uistate.ts, through `crosstalk ui …`), so after a
// restart or --resume nothing comes back twice. The rules it keeps come from
// spike/mod/README.md:
//
// - answers never go through a slash command (its line lands in prompt history)
// - $.ui.log never carries message or question text (it lands in the transcript)
// - a picker comes up only with the prompt empty and no turn running, once by
//   itself; raised before or put off, it waits for a turn of the person's to end
// - a picker's header is 12 characters at most
// - the status line and toasts are plain text
// - cards carry no keys: the band's keys need ctrl+x tab first, so the picker acts
//
// Without the mod (claude -p, the SDK, an older Claude Code, mods turned off)
// nothing here runs, the daemon hears no poll, and every one of these falls back
// to what the classic hooks always did: the restore question as a
// systemMessage, a notice in the transcript, "restore them" and crosstalk_read.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Item, Receipt } from './types'

const items = atom({ plugin: 'crosstalk', key: 'items' } as const, [])
const receipts = atom({ plugin: 'crosstalk', key: 'receipts' } as const, [])

const FRAME = '#6c6c6c'
const SENDER = '#d7875f'
const THREAD = '#5fafd7'
const CARD_MAX = 64

let session = ''
let bin = ''
let label = ''
let repo = ''
let interactive = false
let busy = false
let asking = false
let lastTurnEnd = 0
const turns = new Set<string>()
let lastLineAt = 0
let lastStatus: string | undefined = '\u0000'
/** The card a Reply was chosen on: the next `@<from> …` typed goes to them. */
let armed: { id: string; from: string } | null = null

const FINAL = new Set(['answered', 'handed', 'muted'])

/** One `crosstalk ui …` call; its JSON answer, or `{ ok: false }`. */
async function cli($: EngineInterface, args: string[]): Promise<any> {
  try {
    const r = await $.process.run([bin, 'ui', ...args, '--session', session], { timeoutMs: 120_000 })
    const line = r.stdout.trim().split('\n').pop() ?? ''
    return line ? JSON.parse(line) : { ok: false, error: r.stderr.trim().slice(0, 200) }
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 200) }
  }
}

/** The same rule as src/uistate.ts raisable(): once by itself, then only after a turn has ended since. */
function raisable(it: Item): boolean {
  if (FINAL.has(it.state)) return false
  if (it.raisedAt === undefined) return it.state === 'pending'
  return lastTurnEnd > it.raisedAt
}

const isCard = (it: Item) => it.kind === 'message' || it.kind === 'ask'
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

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

function header(it: Item): string {
  if (it.kind === 'restore') return 'Restore'
  if (it.kind === 'route') return 'Route'
  if (it.kind === 'gather') return 'Gather'
  if (it.kind === 'team') return 'Team'
  return cut(it.thread ? `${it.from} · ${it.thread}` : it.from ?? 'crosstalk', 12)
}

async function showStatus($: EngineInterface, open: Item[]) {
  const threads = [...new Set(open.filter(isCard).map(i => i.thread).filter((t): t is string => !!t))]
  const where = threads.length ? threads.slice(0, 3).join(', ') : repo
  // Nothing waiting and no room: say nothing, rather than a line in every session.
  const text = open.length || label ? `◢ ${where || 'crosstalk'} · ${open.length} waiting` : undefined
  if (text !== lastStatus) $.ui.status(text)
  lastStatus = text
}

async function received($: EngineInterface, line: string) {
  let w: { items?: Item[]; label?: string; note?: { id: string; text: string } }
  try {
    w = JSON.parse(line)
  } catch {
    return
  }
  lastLineAt = await $.clock.now()
  label = w.label ?? ''
  const open = (w.items ?? []).filter(i => !FINAL.has(i.state) && !settled.has(i.id))
  await update($, items, () => open)
  await showStatus($, open)
  if (w.note && !toasted.has(w.note.id)) {
    toasted.add(w.note.id)
    void tookNote($, w.note)
  }
  // Not awaited: a picker can stay up for minutes, and the watch must keep reading.
  void maybeRaise($)
}

/** Receipts already toasted in this process. */
const toasted = new Set<string>()

/** The receipt for sessions brought in: taken once, so no other session or the hook shows it too. */
async function tookNote($: EngineInterface, note: { id: string; text: string }) {
  const r = await cli($, ['act', '--id', note.id, '--action', 'answer'])
  if (r.ok) $.ui.toast(note.text.replace(/^◢ crosstalk: /, ''))
}

/** Settled in this process, so a line the watch printed before it knew cannot bring it back. */
const settled = new Set<string>()

async function forget($: EngineInterface, id: string) {
  settled.add(id)
  await update($, items, list => list.filter(i => i.id !== id))
  await showStatus($, await read($, items))
}

async function markRaised($: EngineInterface, id: string, at: number) {
  await update($, items, list => list.map(i => (i.id === id ? { ...i, raisedAt: at } : i)))
}

/** `crosstalk ui watch` for the session's life; started again if it ever stops. */
async function watch($: EngineInterface) {
  for (;;) {
    let rest = ''
    try {
      for await (const chunk of $.process.spawn({ argv: [bin, 'ui', 'watch', '--session', session] })) {
        if (chunk.stream !== 'stdout') continue
        rest += chunk.text
        let i: number
        while ((i = rest.indexOf('\n')) !== -1) {
          const line = rest.slice(0, i)
          rest = rest.slice(i + 1)
          if (line.trim()) await received($, line)
        }
      }
    } catch {}
    await new Promise(r => $.clock.after(5000, () => r(undefined)))
  }
}

/** Raise the first picker that may come up by itself now, if the person is not busy. */
async function maybeRaise($: EngineInterface) {
  if (asking || busy || !interactive) return
  const next = (await read($, items)).find(raisable)
  if (!next) return
  const box = await $.prompt.read()
  if (box.text.trim()) return
  asking = true
  try {
    const r = await cli($, ['act', '--id', next.id, '--action', 'raised'])
    if (!r.ok) {
      // Settled elsewhere meanwhile (another session, "restore them"): not ours to ask.
      if (r.item) await forget($, next.id)
      return
    }
    await markRaised($, next.id, r.item?.raisedAt ?? (await $.clock.now()))
    await raise($, next)
  } finally {
    asking = false
  }
}

async function raise($: EngineInterface, it: Item) {
  let answer: string
  try {
    if (it.kind === 'restore')
      answer = await $.ui.ask(it.question ?? 'Restore your sessions?', { options: it.options ?? ['Restore', 'Open as windows', 'Not now'], header: header(it) })
    else if (it.kind === 'gather')
      answer = await $.ui.ask(it.question ?? 'Bring your other Claude sessions into crosstalk?', { options: it.options ?? ['Bring them in', 'Not now'], header: header(it) })
    else if (it.kind === 'route')
      answer = await $.ui.ask(it.question ?? 'Which session should get this message?', { options: it.options ?? ['Hold it'], header: header(it) })
    else if (it.kind === 'team')
      answer = await $.ui.ask(it.question ?? `${it.from}'s key changed. Trust the new key?`, { options: it.options ?? ['Trust it', "Don't trust it"], header: header(it) })
    else {
      const what = it.kind === 'ask' ? 'asks' : 'says'
      const options = it.kind === 'ask' ? ['Answer', 'Hand to agent', 'Later', 'Mute'] : ['Hand to agent', 'Reply', 'Mute', 'Later']
      answer = await $.ui.ask(`◢ ${it.from}${it.thread ? ` · ${it.thread}` : ''} ${what}: "${cut(oneLine(it.text ?? ''), 160)}". What should happen to it?`, { options, header: header(it) })
    }
  } catch {
    // Dismissed: it waits in the band until a turn has ended.
    await step($, it, 'later')
    return
  }
  await answered($, it, answer)
}

/** One `crosstalk ui act`, and the band brought in line with it at once. */
async function step($: EngineInterface, it: Item, action: string, value?: string): Promise<any> {
  const r = await cli($, ['act', '--id', it.id, '--action', action, ...(value === undefined ? [] : ['--value', value])])
  const state: string | undefined = r.item?.state
  if (state && FINAL.has(state)) await forget($, it.id)
  else if (state === 'later') await markRaised($, it.id, r.item.raisedAt ?? (await $.clock.now()))
  return r
}

async function answered($: EngineInterface, it: Item, answer: string) {
  if (it.kind === 'restore') {
    const r = await step($, it, 'answer', answer)
    await receipt($, `restore-${it.id}`, r.text ?? r.error ?? 'crosstalk: restore did not answer')
    return
  }
  if (it.kind === 'gather') {
    const r = await step($, it, 'answer', answer)
    $.ui.toast((r.text ?? r.error ?? 'crosstalk: gather did not answer').replace(/^◢ crosstalk: /, '').replace(/\s+/g, ' '))
    return
  }
  if (it.kind === 'team') {
    const r = await step($, it, 'answer', answer)
    $.ui.toast(r.text ?? r.error ?? 'crosstalk: the key question did not answer')
    return
  }
  if (it.kind === 'route') {
    if (answer === 'Hold it') {
      await step($, it, 'later')
      $.ui.toast(`held ${it.from}'s message; it waits here`)
      return
    }
    const r = await step($, it, 'answer', answer)
    $.ui.toast(r.ok ? `sent ${it.from}'s message to ${answer}${r.remembered ? ', and will next time' : ''}` : `could not route it: ${r.error ?? 'no answer'}`)
    return
  }
  switch (answer) {
    case 'Hand to agent':
      return hand($, it)
    case 'Mute':
      await step($, it, 'mute')
      $.ui.toast(`muted ${it.from}'s message`)
      return
    case 'Later':
      await step($, it, 'later')
      return
    case 'Reply':
    case 'Answer':
      armed = { id: it.id, from: it.from ?? '' }
      await $.prompt.fill({ text: `@${it.from} ` })
      $.ui.toast(`type your ${answer === 'Answer' ? 'answer' : 'reply'} to ${it.from}, then Enter`)
      return
    default:
      // Typed under the picker's "Type something.": that is the reply.
      return reply($, it, answer)
  }
}

async function reply($: EngineInterface, it: Item, text: string) {
  const r = await step($, it, 'answer', text)
  $.ui.toast(r.ok ? `${it.kind === 'ask' ? 'answered' : 'replied to'} ${it.from}` : `not sent: ${r.error ?? 'no answer'}`)
}

/** Hand a message to the agent: as data, with a turn to act on it, and a receipt only the person sees. */
async function hand($: EngineInterface, it: Item) {
  const r = await step($, it, 'hand')
  if (!r.ok || !r.text) {
    $.ui.toast(`not handed over: ${r.error ?? 'no answer'}`)
    return
  }
  const appended = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: r.text }] } })
  if ('deny' in appended && appended.deny) {
    $.ui.toast(`not handed over: ${appended.deny}`)
    return
  }
  await receipt($, `hand-${it.id}`, `◢ handed ${it.from}${it.thread ? ` · ${it.thread}` : ''} to the agent`)
  await $.prompt.submit({
    text: `I handed you the crosstalk message from ${it.from}${it.thread ? ` (${it.thread})` : ''} above. Read it and act on it if it concerns this session.`,
  })
}

async function receipt($: EngineInterface, key: string, text: string) {
  // A placed row's id is 1-64 of letters, digits, _ and -.
  const id = key.replace(/[^A-Za-z0-9_-]/g, '_').slice(-64)
  await update($, receipts, list => [...list.filter(r => r.id !== id).slice(-20), { id, text }])
  await $.ui.place({ id })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    interactive = e.isInteractive
    session = await $.session.id()
    bin = `${$.plugin.root}/bin/crosstalk`
    const r = await $.session.repo().catch(() => null)
    repo = (r as { name?: string } | null)?.name ?? e.cwd.split('/').filter(Boolean).pop() ?? ''
    const started = await next(e)
    if (interactive) {
      void watch($)
      // The prompt can empty without any event of ours: look again now and then.
      $.clock.every(2000, () => maybeRaise($))
    }
    return started
  })

  // Before crosstalk's own SessionStart hook runs (modules sit above settings
  // hooks): say the mod is here, so the restore offer becomes a picker and not
  // a systemMessage. A -p run or the SDK has no one to pick, and says nothing.
  on('classic.SessionStart', async ($, e, next) => {
    const id = e.session_id || (await $.session.id())
    const surface = await $.session.surface().catch(() => null)
    if (surface !== null || interactive) {
      bin ||= `${$.plugin.root}/bin/crosstalk`
      session ||= id
      await $.process.run([bin, 'ui', 'hello', '--session', id], { timeoutMs: 10_000 }).catch(() => undefined)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) {
      busy = true
      turns.add(e.turnId)
    }
    return next(e)
  })

  // Only a turn this process saw start counts as the person's turn ending.
  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId === undefined) {
      busy = false
      if (turns.delete(e.turnId)) lastTurnEnd = await $.clock.now()
      $.clock.after(300, () => maybeRaise($))
    }
    return out
  })

  // `@marie sounds good`, after Reply, or for any message waiting from marie:
  // sent as the reply and dropped before it is a prompt. The drop's reason
  // names the person, never the reply.
  on('prompt.submit', async ($, e, next) => {
    const m = e.command || e.isMeta ? null : /^@([\w.-]+)\s+([\s\S]+)$/.exec(e.text.trim())
    if (!m) return next(e)
    const who = m[1]!.toLowerCase()
    const open = (await read($, items)).filter(isCard)
    const it =
      (armed && armed.from.toLowerCase() === who ? open.find(i => i.id === armed!.id) : undefined) ??
      open.find(i => (i.from ?? '').toLowerCase() === who)
    if (!it) return next(e)
    armed = null
    void reply($, it, m[2]!.trim())
    // A drop hands the text back to the box; clear it once that has happened.
    $.clock.after(150, () => $.prompt.fill({ text: '' }))
    return { drop: `crosstalk: reply to ${it.from}` }
  }).catch(($, e, next) => (next.called ? next(e) : { drop: 'crosstalk: reply failed' }))

  // crosstalk's own deliveries into the inbox (a notice, a route question, a
  // message in full) are what the cards replace: taken here, they never reach
  // the model. Only while the watch is alive; otherwise the classic notice is
  // the person's only way to hear of it, so it goes through.
  on('session.receive', async ($, e, next) => {
    const ours = /from-name="crosstalk ◢/.test(e.text)
    if (!ours || (await $.clock.now()) - lastLineAt > 15_000) return next(e)
    return { consumed: 'crosstalk: shown by its mod' }
  }).catch(($, e, next) => (next.called ? next(e) : { consumed: 'crosstalk: held back' }))

  on('ui.render', { component: 'Placed' }, async ($, e, next) => {
    if (e.props.plugin !== $.plugin.name) return next(e)
    const r = (await read($, receipts)).find(x => x.id === e.props.id)
    if (!r) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    // A text child takes no control characters: one Text per line, tabs and the rest as spaces.
    const lines = r.text.split(/\r?\n/).map(l => l.replace(/[\u0000-\u001f\u007f]/g, ' '))
    return (
      <Box flexDirection="column">
        {lines.map((l, i) => (
          <Text key={`l${i}`} dimColor>
            {l || ' '}
          </Text>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const open = await read($, items)
    if (open.length === 0) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const W = Math.max(24, Math.min(e.props.bodyColumns, CARD_MAX))
    const later = (it: Item) => (raisable(it) ? '' : ' · picker after your next turn')
    return (
      <Box flexDirection="column">
        {open.map(it => {
          if (it.kind === 'restore')
            return (
              <Text key={it.id} wrap="truncate">
                <Text color={THREAD} bold>◢ restore</Text>
                <Text dimColor>
                  {' '}
                  · {it.count ?? 0} session{it.count === 1 ? '' : 's'} waiting · or say "restore them"{later(it)}
                </Text>
              </Text>
            )
          if (it.kind === 'gather')
            return (
              <Text key={it.id} wrap="truncate">
                <Text color={THREAD} bold>◢ gather</Text>
                <Text dimColor>
                  {' '}
                  · {it.count ?? 0} session{it.count === 1 ? '' : 's'} without crosstalk · or say "bring them in"{later(it)}
                </Text>
              </Text>
            )
          if (it.kind === 'team')
            return (
              <Text key={it.id} wrap="truncate">
                <Text color={THREAD} bold>◢ team</Text>
                <Text dimColor>
                  {' '}
                  · {it.from}'s key changed and is not trusted yet{later(it)}
                </Text>
              </Text>
            )
          if (it.kind === 'route')
            return (
              <Text key={it.id} wrap="truncate">
                <Text color={THREAD} bold>◢ route</Text>
                <Text dimColor>
                  {' '}
                  · a message from {it.from} needs a session{later(it)}
                </Text>
              </Text>
            )
          const head = `◢ ${it.from} · ${it.thread ?? 'crosstalk'}`
          const a = age(it.ts, now)
          const fill = Math.max(1, W - 7 - head.length - a.length)
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
              <Box width={W}>
                <Text color={FRAME}>│ </Text>
                <Box flexGrow={1}>
                  <Text wrap="truncate">
                    {it.kind === 'ask' ? '? ' : ''}
                    {oneLine(it.text ?? '')}
                  </Text>
                </Box>
                <Text color={FRAME}> │</Text>
              </Box>
              {(it.chips ?? []).map((c, i) => (
                <Box key={`${it.id}:chip${i}`} width={W}>
                  <Text color={FRAME}>│ </Text>
                  <Box flexGrow={1}>
                    <Text wrap="truncate">
                      <Text color="suggestion">▸ {c.kind}</Text> {c.label} <Text dimColor>{size(c.bytes)}</Text>
                    </Text>
                  </Box>
                  <Text color={FRAME}> │</Text>
                </Box>
              ))}
              {later(it) ? (
                <Box width={W}>
                  <Text color={FRAME}>│ </Text>
                  <Box flexGrow={1}>
                    <Text dimColor wrap="truncate">
                      the picker comes after your next turn
                    </Text>
                  </Box>
                  <Text color={FRAME}> │</Text>
                </Box>
              ) : null}
              <Text color={FRAME}>╰{'─'.repeat(W - 2)}╯</Text>
            </Box>
          )
        })}
      </Box>
    )
  })
}
