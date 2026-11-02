// crosstalk's mod under `claude plugin test .`: the thread pane draws what
// `crosstalk ui pane` printed, the card picker offers four options with Mute
// and Later behind More…, and an @ shortcut is taken before it is a prompt.
// Nothing here reaches a model: the kit has none.

import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'crosstalk',
  component: 'Pane',
  requestId: 'thread',
  props: {
    title: '◢ auth',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const PANE_LINE = JSON.stringify({
  ok: true,
  pane: {
    thread: 'auth',
    status: 'active',
    people: ['paul', 'marie'],
    sessions: 2,
    waiting: ['keep the v1 endpoint? (blocking)'],
    decision: { text: 'v1 tokens accepted until 0.2', who: 'paul', at: 1 },
    recent: [{ from: 'marie', text: 'token format changed to v2', ts: 1 }],
    features: [{ name: 'v2 token format', risk: 'risky', flag: 'auth-v2-tokens', stage: 'internal', state: 'merged' }],
  },
})

const CARD = {
  id: 'msg:1',
  kind: 'message',
  sessionId: 's1',
  state: 'pending',
  createdAt: 1,
  updatedAt: 1,
  from: 'marie',
  thread: 'auth',
  text: 'Token format changed to v2',
  ts: 1,
}

/** Stands for the crosstalk CLI: `ui watch` has one card, `ui pane --watch` the pane, `ui act` agrees. */
function engine(on: any, acts: string[][], ask?: (q: { question: string; options: string[] }) => string | null) {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('tool.call', (_: unknown, e: any) => {
    if (e.tool !== 'AskUserQuestion') return { result: { content: [{ type: 'text', text: 'shown' }] } }
    const q = e.questions[0]
    const pick = ask?.({ question: q.question, options: q.options.map((o: { label: string }) => o.label) })
    if (!pick) return { deny: 'dismissed' }
    return { result: { questions: e.questions, answers: { [q.question]: pick } } }
  })
  on('prompt.submit', (_: unknown, e: any) => ({ text: e.text }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('session.repo', () => ({ value: { name: 'api' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.read', () => ({ value: { text: '' } }))
  on('prompt.fill', () => ({ value: {} }))
  on('process.spawn', async function* (_: unknown, e: any) {
    if (e.argv.includes('watch') && e.argv.includes('ui') && !e.argv.includes('pane'))
      yield { stream: 'stdout', text: JSON.stringify({ items: [CARD], label: 'paul', threads: ['auth'] }) + '\n' }
    if (e.argv.includes('pane')) yield { stream: 'stdout', text: PANE_LINE + '\n' }
    return { value: { code: 0, signal: null } }
  })
  on('process.run', (_: unknown, e: any) => {
    const argv: string[] = e.argv ?? e
    acts.push(argv)
    const i = argv.indexOf('--action')
    const action = i === -1 ? '' : argv[i + 1]
    const state = action === 'mute' ? 'muted' : action === 'later' ? 'later' : 'pending'
    if (argv.includes('at')) return { value: { stdout: JSON.stringify({ handled: true, ok: true, toast: 'answered auth' }) + '\n', stderr: '', code: 0 } }
    return { value: { stdout: JSON.stringify({ ok: true, item: { ...CARD, state, raisedAt: 2 } }) + '\n', stderr: '', code: 0 } }
  })
  return clock
}

test('the pane draws a thread: waiting, decision, features with flag stage, recent', async ($, on) => {
  const acts: string[][] = []
  const clock = engine(on, acts)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.tool.call({ tool: 'mcp__plugin_crosstalk_crosstalk__crosstalk_pane', thread: 'auth' } as any)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /keep the v1 endpoint/ }))?.text).toContain('blocking')
    expect((await ui.find({ type: 'Text', text: /v1 tokens accepted/ }))?.text).toContain('paul')
    expect((await ui.find({ type: 'Text', text: /v2 token format/ }))?.text).toContain('flag auth-v2-tokens at internal')
    await clock.settle()
    expect(await ui.find({ type: 'Text', text: /token format changed to v2/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the card picker: Hand to agent / Reply / Open thread / More…, and More… opens Mute / Later', async ($, on) => {
  const acts: string[][] = []
  const asked: { question: string; options: string[] }[] = []
  const clock = engine(on, acts, q => {
    asked.push(q)
    return q.options.includes('More…') ? 'More…' : 'Mute'
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  expect(asked[0]?.options).toEqual(['Hand to agent', 'Reply', 'Open thread', 'More…'])
  expect(asked[1]?.options).toEqual(['Mute', 'Later'])
  expect(acts.some(a => a.includes('--action') && a[a.indexOf('--action') + 1] === 'mute')).toBe(true)
})

test('@auth keep v1 is taken before it is a prompt, and the drop names the thread, not the text', async ($, on) => {
  const acts: string[][] = []
  const clock = engine(on, acts, () => null)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  const r: any = await $.prompt.submit({ text: '@auth keep v1 for now' } as any)
  expect(r.drop).toBe('crosstalk: answer sent to auth')
  expect(String(r.drop)).not.toContain('keep v1')
  const passed: any = await $.prompt.submit({ text: '@README.md explain this' } as any)
  expect(passed.drop).toBeUndefined()
})
