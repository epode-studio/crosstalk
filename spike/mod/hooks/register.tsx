// crosstalk spike mod: other threads' questions in a status line and a band,
// answers taken before they become prompts, peer deliveries taken before the
// model reads them. Everything here is meant to be seen by the person only;
// spike/mod/README.md records what actually stays out of the model.
//
// The daemon is stood in for by two files under $CROSSTALK_SPIKE_DIR
// (default ~/.crosstalk): spike-questions.json, which something else writes,
// and spike-answers.json, which this mod writes.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Peer, Question } from '../types'

const questions = atom({ plugin: 'crosstalk-spike', key: 'questions' } as const, [])
const answered = atom({ plugin: 'crosstalk-spike', key: 'answered' } as const, [])
const peers = atom({ plugin: 'crosstalk-spike', key: 'peers' } as const, [])

// `@auth y`, `@auth no, wait for the migration`
const AT = /^@([a-z0-9][\w-]*)\s+([\s\S]+)$/i

let dir = ''
let lastRaw = ''
let lastStatus: string | undefined = ''
const toasted = new Set<string>()

async function pending($: EngineInterface) {
  const done = new Set(await read($, answered))
  return (await read($, questions)).filter(q => !done.has(q.id))
}

async function showStatus($: EngineInterface) {
  const open = await pending($)
  const threads = [...new Set(open.map(q => q.thread))]
  const note = await $.fs.read(`${dir}/spike-status.txt`).catch(() => '')
  const text =
    open.length === 0 && note === ''
      ? undefined
      : `◢ ${threads.join(', ') || 'crosstalk'} · ${open.length} waiting${note ? ` · ${note.trim()}` : ''}`
  if (text !== lastStatus) $.ui.status(text)
  lastStatus = text
}

async function poll($: EngineInterface) {
  const raw = await $.fs.read(`${dir}/spike-questions.json`).catch(() => '')
  if (raw !== lastRaw) {
    lastRaw = raw
    let list: Question[] = []
    try {
      list = (JSON.parse(raw || '{}').questions ?? []) as Question[]
    } catch {}
    await update($, questions, () => list)
    for (const q of list) {
      if (!toasted.has(q.id) && q.toast) $.ui.toast(q.toast, { timeoutMs: 8000 })
      toasted.add(q.id)
    }
  }
  await showStatus($)
}

async function answer($: EngineInterface, thread: string, text: string, via: string) {
  const q = (await pending($)).find(q => q.thread.toLowerCase() === thread.toLowerCase())
  if (!q) return undefined
  const path = `${dir}/spike-answers.json`
  const prev = await $.fs.read(path).catch(() => '[]')
  let list: unknown[] = []
  try {
    list = JSON.parse(prev)
  } catch {}
  list.push({ id: q.id, thread: q.thread, answer: text, via, at: await $.clock.now() })
  await $.fs.write(path, JSON.stringify(list, null, 2) + '\n')
  await update($, answered, ids => [...ids, q.id])
  await showStatus($)
  return q
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    dir = (await $.env.get('CROSSTALK_SPIKE_DIR')) ?? `${await $.env.get('HOME')}/.crosstalk`
    await $.command.register({
      name: 'xt-answer',
      description: 'Answer a crosstalk question: /xt-answer <thread> <answer>',
      argumentHint: '<thread> <answer>',
      immediate: true,
    })
    await poll($)
    $.clock.every(1000, () => poll($))
    return next(e)
  })

  // A typed `@thread answer` never becomes a prompt.
  on('prompt.submit', async ($, e, next) => {
    const m = e.command || e.isMeta ? null : AT.exec(e.text.trim())
    if (!m) return next(e)
    const q = await answer($, m[1]!, m[2]!.trim(), 'prompt')
    if (!q) return next(e)
    $.ui.toast(`answered ${q.thread}`)
    // A drop hands the text back to the box; clear it once that has happened.
    $.clock.after(150, () => $.prompt.fill({ text: '' }))
    return { drop: `crosstalk: answer sent to ${q.thread}` }
  }).catch(($, e, next) => (next.called ? next(e) : { drop: 'crosstalk: answer failed' }))

  // `/xt-answer auth y`: answered with no text, so the reply row is empty.
  on('command.run', { command: 'xt-answer' }, async ($, e) => {
    const [thread = '', ...rest] = e.args.trim().split(/\s+/)
    const q = await answer($, thread, rest.join(' '), 'command')
    $.ui.toast(q ? `answered ${q.thread}` : `nothing waiting from ${thread}`)
    return {}
  })

  // Peer deliveries are drawn, never queued. `PASSTHRU` in a message lets it
  // through, as the spike's control that a raw socket write does reach the model.
  on('session.receive', async ($, e, next) => {
    await $.fs
      .write(`${dir}/spike-received.json`, JSON.stringify({ origin: e.origin, length: e.text.length }) + '\n')
      .catch(() => {})
    const isPeer = e.origin.kind === 'peer' || e.origin.kind === 'peer-send-message' || e.origin.kind === 'unclassified'
    if (!isPeer || e.text.includes('PASSTHRU')) return next(e)
    // src/inject.ts quotes the peer's text between BEGIN/END markers.
    const quoted = /-{5} BEGIN QUOTED MESSAGE \w+ -{5}\n([\s\S]*?)\n-{5} END/.exec(e.text)?.[1]
    const from = /from-name="([^"]*)"/.exec(e.text)?.[1] ?? e.origin.kind
    const body = `${from}: ${(quoted ?? e.text.replace(/<\/?cross-session-message[^>]*>/g, '')).trim()}`
    const peer: Peer = { at: await $.clock.now(), origin: e.origin.kind, text: body }
    await update($, peers, list => [...list.slice(-4), peer])
    $.ui.log(`crosstalk: took a peer message (${e.origin.kind}); see the band. xt-log PLUM-6142`)
    return { consumed: 'crosstalk-spike: shown in the band' }
  }).catch(($, e, next) => (next.called ? next(e) : { consumed: 'crosstalk-spike: hook failed, held back' }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const open = await pending($)
    const msgs = await read($, peers)
    if (open.length === 0 && msgs.length === 0) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {open.map((q, i) => (
          <Box key={q.id}>
            <Text>
              <Text bold>@{q.thread}</Text> {q.text}{' '}
            </Text>
            <Button key={`${q.id}:y`} label="y" hotkey={i === 0 ? 'y' : undefined} onPress={() => answer($, q.thread, 'y', 'band')} />
            <Button key={`${q.id}:n`} label="n" hotkey={i === 0 ? 'n' : undefined} onPress={() => answer($, q.thread, 'n', 'band')} />
          </Box>
        ))}
        {msgs.map(p => (
          <Text key={`m${p.at}`} dimColor>
            ← {p.text.slice(0, 200)}
          </Text>
        ))}
        {msgs.length > 0 ? <Button key="clear" label="clear messages" onPress={() => update($, peers, () => [])} /> : null}
      </Box>
    )
  })
}
