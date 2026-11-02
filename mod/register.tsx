// crosstalk's mod: everything crosstalk shows a person, as Claude Code's own UI,
// kept out of the model until the person hands something over.
//
//   a message      a card in the band above the prompt, then the picker:
//                  Hand to agent / Reply / Open thread / More…, and More… opens
//                  a second picker, Mute / Later ($.ui.ask takes four options)
//   a question     a peer's crosstalk ask: Answer / Hand to agent / Open thread / More…
//   the pane       a thread beside the chat: status, people, what is waiting, the
//                  latest decision, recent messages, features with risk and flag.
//                  By itself in the main session (drawn from 144 columns), and
//                  when asked: Open thread, or the agent's crosstalk_pane. Live.
//   invite         the words for someone joining a room or a link, from
//                  crosstalk_room / crosstalk_link: shown here, never to the model
//   doctor         something broken, noticed at SessionStart, with the fix
//   digest         at a pause (a turn ends, nothing runs; at most every two
//                  hours), one line in the band of what happened in the threads
//   @ shortcuts    optional, never needed: `@<thread> <text>` answers what that
//                  thread is waiting on, `@<person> <text>` replies, `@main`,
//                  `@main off`, `@restore [no|windows]`; taken before they are a prompt
//   a route        "which session gets ben's message?": the sessions, and Hold it
//   restore        "Restore 6 sessions?": Restore / Open as windows / Not now
//   gather         "4 Claude sessions started before crosstalk. Bring them in?":
//                  Bring them in / Not now, and a toast once they are in
//   cleanup        "2 agent worktrees are done with. Remove them?":
//                  Remove them / Not now
//   thread         "which thread is api part of?": the threads, New thread, No thread
//   thread note    "auth and auth-ui combined…": a toast
//   rule           "You answered … twice. Always do this?": Always do this / Not now
//   connect        "Connect with your team in <repo>?": Connect / Not in this repo
//   conflict       "auth and billing cannot agree who changes parse()": the threads
//   attention      "api's context is 91% spent. Start fresh from auth?", "auth has
//                  been stuck for 2 hours. Add a second agent?", "bg-1 (in the
//                  background) wants to use Bash: …": its options (src/attention)
//   push           away from the keyboard: Claude Code's own PushNotification, a
//                  sealed line with no question text in it
//   context        after each turn, how much of the window is spent, to
//                  `crosstalk attn context` (a fresh session instead of compacting)
//   main           the status line of a main session counts every session
//   own thread     a message about this session's own thread is handed to the
//                  agent by itself (as data), when the prompt is empty and idle
//   status line    ◢ <threads or repo> · :4100 · <n> waiting, the ports of this
//                  worktree's crosstalk services (docs/services.md) after the name,
//                  or its name through crosstalk's proxy, auth.localhost:1355
//   links          the pane's Links: the thread's URLs by kind (local, previews,
//                  PRs, links found in output), clickable, alive or dead
//                  (docs/urls.md); in the main session every thread's
//   screenshots    the pane's before / after lines, each a file link (OSC 8):
//                  a mod cannot draw an image; a service that broke is marked
//                  in Services (src/urls/shots/, src/urls/health/)
//   tab status     working / waiting on you / done on this session's own tab,
//                  through `crosstalk term status` (src/terminal/status.ts)
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

import type { Item, Pane, Receipt } from './types'
import { HANDED_PROMPT, LATER, MORE, MORE_OPTIONS, MUTE, OPEN_THREAD, ago, cardOptions, featureLine, fileLink, linkGroups, linkLine, linkable, parseAt, shotLine, takesAt } from '../src/ui-extra/pure.ts'

const items = atom({ plugin: 'crosstalk', key: 'items' } as const, [])
const receipts = atom({ plugin: 'crosstalk', key: 'receipts' } as const, [])
const paneAtom = atom({ plugin: 'crosstalk', key: 'pane' } as const, null as Pane | null)
const paneError = atom({ plugin: 'crosstalk', key: 'paneError' } as const, '')
const digestAtom = atom({ plugin: 'crosstalk', key: 'digest' } as const, '')

const PANE_ID = 'thread'

const FRAME = '#6c6c6c'
const SENDER = '#d7875f'
const THREAD = '#5fafd7'
const CARD_MAX = 64

let session = ''
let bin = ''
let label = ''
let repo = ''
/** This worktree's services' ports, `:4100`, or its proxy name, `auth.localhost:1355`, from the watch. */
let ports = ''
/** This session's threads, from the daemon: what the status line leads with. */
let threadNames: string[] = []
/** Set while this is the main session: totals across every session. */
let mainTotals: { sessions: number; threads: number; waiting: number } | null = null
let interactive = false
let busy = false
let asking = false
let lastTurnEnd = 0
const turns = new Set<string>()
let lastLineAt = 0
let lastStatus: string | undefined = '\u0000'
/** The card a Reply was chosen on: the next `@<from> …` typed goes to them. */
let armed: { id: string; from: string } | null = null
/** The thread the pane follows, and which of its watches is the live one. */
let paneThread: string | undefined
let paneGen = 0
/** The main session's pane is opened by itself once per process. */
let paneAuto = false
/** When the digest was last looked for at a pause. */
let digestAt = 0

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
  if (it.kind === 'cleanup') return 'Clean up'
  if (it.kind === 'thread') return 'Thread'
  if (it.kind === 'ship') return 'Ship'
  if (it.kind === 'rule') return 'Rule'
  if (it.kind === 'connect') return 'Connect'
  if (it.kind === 'conflict') return 'Conflict'
  if (it.kind === 'invite') return 'Invite'
  if (it.kind === 'doctor') return 'crosstalk'
  if (it.kind === 'disk') return 'Disk'
  if (it.kind === 'install') return 'Team'
  if (it.kind === 'steer') return 'Steer'
  if (it.kind === 'session') return 'Session'
  if (it.kind === 'env') return 'Local files'
  if (it.kind === 'attention') return it.id.startsWith('attn:perm:') ? 'Permission' : it.id.startsWith('attn:staff:') ? 'Staffing' : 'Fresh start'
  return cut(it.thread ? `${it.from} · ${it.thread}` : it.from ?? 'crosstalk', 12)
}

async function showStatus($: EngineInterface, open: Item[]) {
  // `◢ auth · tokens · 1 waiting`: the session's own threads first, else what the cards are about.
  const threads = [...new Set(open.filter(isCard).map(i => i.thread).filter((t): t is string => !!t))]
  const named = threadNames.length ? threadNames.slice(0, 3).join(' · ') : threads.length ? threads.slice(0, 3).join(', ') : repo
  // `auth · :4100`: the ports of what crosstalk runs here, the numbers and nothing more.
  const where = ports ? `${named || 'crosstalk'} · ${ports}` : named
  // Nothing waiting and no room: say nothing, rather than a line in every session.
  const text = mainTotals
    ? `◢ main · ${mainTotals.sessions} session${mainTotals.sessions === 1 ? '' : 's'} · ${mainTotals.threads} thread${mainTotals.threads === 1 ? '' : 's'} · ${Math.max(mainTotals.waiting, open.length)} waiting`
    : open.length || label || ports
      ? `◢ ${where || 'crosstalk'} · ${open.length} waiting`
      : undefined
  if (text !== lastStatus) $.ui.status(text)
  lastStatus = text
}

let lastOpen = -1

/**
 * This session's state on its own tab. Never awaited: the CLI writes what is
 * wanted and leaves the terminal to a detached applier, and a slow terminal
 * must never hold a turn up.
 */
function tabStatus($: EngineInterface, event: string) {
  if (!interactive || !bin || !session) return
  void $.process.run([bin, 'term', 'status', '--session', session, '--event', event], { timeoutMs: 10_000 }).catch(() => undefined)
}

async function received($: EngineInterface, line: string) {
  let w: {
    items?: Item[]
    label?: string
    ports?: string
    note?: { id: string; text: string }
    threads?: string[]
    threadNotes?: { id: string; text: string }[]
    main?: { sessions: number; threads: number; waiting: number }
    push?: { id: string; text: string }
  }
  try {
    w = JSON.parse(line)
  } catch {
    return
  }
  lastLineAt = await $.clock.now()
  label = w.label ?? ''
  ports = typeof w.ports === 'string' ? w.ports.replace(/[^a-z0-9.:\- …]/gi, '').slice(0, 80) : ''
  threadNames = Array.isArray(w.threads) ? w.threads.filter((t): t is string => typeof t === 'string') : []
  mainTotals = w.main && typeof w.main.sessions === 'number' ? w.main : null
  for (const n of w.threadNotes ?? [])
    if (!toasted.has(n.id)) {
      toasted.add(n.id)
      $.ui.toast(oneLine(n.text.replace(/^◢ crosstalk: /, '')))
    }
  const open = (w.items ?? []).filter(i => !FINAL.has(i.state) && !settled.has(i.id))
  await update($, items, () => open)
  await showStatus($, open)
  // Something came in, or was settled, while no turn runs: the tab says so.
  if (open.length !== lastOpen) {
    if (lastOpen !== -1 && !busy) tabStatus($, 'refresh')
    lastOpen = open.length
  }
  if (w.push && !toasted.has(w.push.id)) {
    toasted.add(w.push.id)
    void phone($, w.push.text)
  }
  if (w.note && !toasted.has(w.note.id)) {
    toasted.add(w.note.id)
    void tookNote($, w.note)
  }
  // The main session gets the pane by itself: drawn as a sidebar from 144
  // columns, and below that it waits until the person opens it.
  if (mainTotals && !paneAuto && interactive) {
    paneAuto = true
    void openPane($, undefined)
  }
  // Not awaited: a picker can stay up for minutes, and the watch must keep reading.
  void maybeRaise($)
}

/**
 * Show a thread in the pane, and keep it current: `crosstalk ui pane --watch`
 * prints it again whenever it changes. Opening another thread retires the
 * watch before it; so does the pane being closed.
 */
async function openPane($: EngineInterface, thread: string | undefined): Promise<boolean> {
  if (thread !== paneThread) await update($, paneAtom, () => null)
  paneThread = thread
  const gen = ++paneGen
  await update($, paneError, () => '')
  void followPane($, gen, thread)
  const r = await $.ui.open({ id: PANE_ID, title: thread ? `◢ ${thread}` : '◢ thread' }).catch(() => ({ isPlaced: false }))
  return r.isPlaced
}

async function followPane($: EngineInterface, gen: number, thread: string | undefined) {
  let rest = ''
  try {
    const argv = [bin, 'ui', 'pane', '--watch', '--session', session, ...(thread ? ['--thread', thread] : [])]
    for await (const chunk of $.process.spawn({ argv })) {
      if (gen !== paneGen) break
      if (chunk.stream !== 'stdout') continue
      rest += chunk.text
      let i: number
      while ((i = rest.indexOf('\n')) !== -1) {
        const line = rest.slice(0, i)
        rest = rest.slice(i + 1)
        if (!line.trim()) continue
        let p: { ok: boolean; pane?: Pane; error?: string; threads?: string[] }
        try {
          p = JSON.parse(line)
        } catch {
          continue
        }
        if (p.ok && p.pane) {
          await update($, paneAtom, () => p.pane!)
          await update($, paneError, () => '')
        } else await update($, paneError, () => `${p.error ?? 'nothing to show'}${p.threads?.length ? ` · threads: ${p.threads.join(', ')}` : ''}`)
      }
    }
  } catch {}
}

/**
 * Claude Code's own push to the phone (its PushNotification tool, there when
 * Remote Control push is set up). The line is crosstalk's sealed one: a count
 * and a thread name, never the question.
 */
async function phone($: EngineInterface, text: string) {
  try {
    const tools = await $.tool.list()
    if (!tools.some(t => t.name === 'PushNotification')) return
    await $.tool.call({ tool: 'PushNotification', message: text.slice(0, 180), status: 'proactive' } as never)
  } catch {}
}

/** How much of the window is spent, for a fresh session instead of a compaction. Never awaited. */
function reportContext($: EngineInterface) {
  if (!bin || !session) return
  void (async () => {
    try {
      const u = await $.session.usage()
      const pct = u.context.percent
      if (pct === undefined) return
      await $.process.run([bin, 'attn', 'context', '--session', session, '--percent', String(pct), '--tokens', String(u.context.tokens ?? 0), '--window', String(u.context.window)], { timeoutMs: 10_000 })
    } catch {}
  })()
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
  // Taken before the first await: the 2s timer, a watch line and a turn ending
  // all call this, and one passing the check while another awaits would raise
  // the same picker twice, or hand the same message over twice.
  asking = true
  try {
    const all = await read($, items)
    // About this session's own thread: it goes to the agent without asking, once.
    const own = all.find(i => i.auto && isCard(i) && i.state === 'pending' && i.raisedAt === undefined)
    const next = own ?? all.find(raisable)
    if (!next) return
    const box = await $.prompt.read()
    if (box.text.trim()) return
    if (own) {
      await markRaised($, own.id, await $.clock.now())
      await hand($, own, true)
      return
    }
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
    else if (it.kind === 'cleanup')
      answer = await $.ui.ask(it.question ?? 'Remove the agent worktrees that are done with?', { options: it.options ?? ['Remove them', 'Not now'], header: header(it) })
    else if (it.kind === 'route')
      answer = await $.ui.ask(it.question ?? 'Which session should get this message?', { options: it.options ?? ['Hold it'], header: header(it) })
    else if (it.kind === 'team')
      answer = await $.ui.ask(it.question ?? `${it.from}'s key changed. Trust the new key?`, { options: it.options ?? ['Trust it', "Don't trust it"], header: header(it) })
    else if (it.kind === 'ship')
      answer = await $.ui.ask(it.question ?? 'crosstalk has a shipping question', { options: it.options ?? ['Not yet'], header: header(it) })
    else if (it.kind === 'thread')
      answer = await $.ui.ask(it.question ?? 'Which thread is this session part of?', { options: it.options ?? ['New thread', 'No thread'], header: header(it) })
    else if (it.kind === 'rule' || it.kind === 'connect' || it.kind === 'conflict' || it.kind === 'invite' || it.kind === 'doctor' || it.kind === 'disk' || it.kind === 'install' || it.kind === 'attention' || it.kind === 'steer' || it.kind === 'session' || it.kind === 'env')
      answer = await $.ui.ask(it.question ?? 'crosstalk has a question', { options: (it.options ?? ['Not now']).slice(0, 4), header: header(it) })
    else {
      const what = it.kind === 'ask' ? 'asks' : 'says'
      const asked = `◢ ${it.from}${it.thread ? ` · ${it.thread}` : ''} ${what}: "${cut(oneLine(it.text ?? ''), 160)}". What should happen to it?`
      answer = await $.ui.ask(asked, { options: cardOptions(it.kind), header: header(it) })
      // Four options is all a picker takes: the rest are one step further.
      if (answer === MORE) answer = await $.ui.ask(`◢ ${it.from}${it.thread ? ` · ${it.thread}` : ''}: mute it, or keep it for later?`, { options: [...MORE_OPTIONS], header: header(it) })
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
  if (it.kind === 'cleanup') {
    const r = await step($, it, 'answer', answer)
    await receipt($, `cleanup-${it.id}`, r.text ?? r.error ?? 'crosstalk: cleanup did not answer')
    return
  }
  if (it.kind === 'ship') {
    const r = await step($, it, 'answer', answer)
    await receipt($, `ship-${it.id}`, r.text ?? r.error ?? 'crosstalk: the shipping question did not answer')
    return
  }
  if (it.kind === 'disk') {
    // "Show me" and "Free it" answer with a list or a receipt, which a toast would cut short.
    const r = await step($, it, 'answer', answer)
    await receipt($, `disk-${it.id}`, r.text ?? r.error ?? 'crosstalk: the disk question did not answer')
    return
  }
  if (it.kind === 'rule' || it.kind === 'connect' || it.kind === 'conflict' || it.kind === 'invite' || it.kind === 'install' || it.kind === 'attention' || it.kind === 'steer' || it.kind === 'session' || it.kind === 'env') {
    const r = await step($, it, 'answer', answer)
    $.ui.toast(oneLine((r.text ?? r.error ?? 'crosstalk did not answer').replace(/^◢ crosstalk: /, '')))
    return
  }
  if (it.kind === 'doctor') {
    const r = await step($, it, 'answer', answer)
    // The person asked for it: the problem and its fix go to the agent, as their own turn.
    if (r.ok && r.prompt) await $.prompt.submit({ text: String(r.prompt) })
    else $.ui.toast(oneLine(r.text ?? r.error ?? 'crosstalk did not answer'))
    return
  }
  if (it.kind === 'thread') {
    const r = await step($, it, 'answer', answer)
    $.ui.toast(r.ok ? (r.threads?.length ? `this session is in ${r.threads.join(', ')}` : 'this session is in no thread') : `not placed: ${r.error ?? 'no answer'}`)
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
    case MUTE:
      await step($, it, 'mute')
      $.ui.toast(`muted ${it.from}'s message`)
      return
    case LATER:
      await step($, it, 'later')
      return
    case OPEN_THREAD: {
      // The card stays, for after the person has looked.
      await step($, it, 'later')
      const placed = await openPane($, it.thread)
      if (!placed) $.ui.toast(`the ${it.thread ?? 'thread'} pane opens when there is room for it`)
      return
    }
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

/**
 * Hand a message to the agent: as data, and a receipt only the person sees.
 *
 * Handed by the person, a turn follows to act on it, in words that name
 * nobody (HANDED_PROMPT): a sender's label, session or thread is theirs to
 * choose, and in the person's voice it would be words they never said. Passed
 * on by crosstalk because it is about this session's own thread (`auto`), the
 * daemon frames it as exactly that, and no turn starts in the person's voice.
 *
 * If the row cannot be appended the claim is undone: a message marked handed
 * and read but never delivered would be lost.
 */
async function hand($: EngineInterface, it: Item, auto = false) {
  const r = await step($, it, 'hand', auto ? 'auto' : undefined)
  if (!r.ok || !r.text) {
    $.ui.toast(`not handed over: ${r.error ?? 'no answer'}`)
    return
  }
  const appended = await $.session
    .append({ message: { type: 'user', content: [{ type: 'text', text: r.text }] } })
    .catch((err: unknown) => ({ deny: String(err).slice(0, 120) }))
  if ('deny' in appended && appended.deny) {
    await cli($, ['act', '--id', it.id, '--action', 'unhand'])
    settled.delete(it.id)
    $.ui.toast(`not handed over: ${appended.deny}`)
    return
  }
  await receipt($, `hand-${it.id}`, auto ? `◢ passed ${it.from}${it.thread ? ` · ${it.thread}` : ''} to the agent: its own thread` : `◢ handed ${it.from}${it.thread ? ` · ${it.thread}` : ''} to the agent`)
  if (!auto) await $.prompt.submit({ text: HANDED_PROMPT })
}

async function receipt($: EngineInterface, key: string, text: string) {
  // A placed row's id is 1-64 of letters, digits, _ and -.
  const id = key.replace(/[^A-Za-z0-9_-]/g, '_').slice(-64)
  await update($, receipts, list => [...list.filter(r => r.id !== id).slice(-20), { id, text }])
  await $.ui.place({ id })
}

/** An @ shortcut the prompt hook took: done by `crosstalk ui at`, said in a toast. */
async function shortcut($: EngineInterface, text: string) {
  const r = await cli($, ['at', '--text', text])
  if (r.handled === false) {
    // Nothing of crosstalk's answered to it after all: the person's words go back in the box.
    await $.prompt.fill({ text })
    $.ui.toast('nothing is waiting there; your text is back in the prompt')
    return
  }
  $.ui.toast(oneLine(r.toast ?? r.error ?? 'crosstalk did not answer'))
}

/** At a pause, the digest's line in the band: at most every two hours, only when something happened. */
async function pauseDigest($: EngineInterface) {
  if (busy || !interactive || asking) return
  const now = await $.clock.now()
  if (now - digestAt < 10 * 60_000) return
  digestAt = now
  const r = await cli($, ['digest', '--band'])
  if (r.ok && typeof r.line === 'string' && r.line && !busy) await update($, digestAtom, () => oneLine(r.line))
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

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      busy = true
      turns.add(e.turnId)
      tabStatus($, 'UserPromptSubmit')
      // The digest's line was for the pause; the pause is over.
      if (await read($, digestAtom)) await update($, digestAtom, () => '')
    }
    return next(e)
  })

  // Only a turn this process saw start counts as the person's turn ending.
  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId === undefined) {
      busy = false
      if (turns.delete(e.turnId)) lastTurnEnd = await $.clock.now()
      tabStatus($, 'Stop')
      reportContext($)
      $.clock.after(300, () => maybeRaise($))
      // A natural pause: once the turn has been over a moment and nothing runs.
      $.clock.after(1500, () => pauseDigest($))
    }
    return out
  })

  // Optional shortcuts, never needed (the picker and plain words do it all),
  // taken before they become a prompt. The drop's reason names the thread or
  // person, never the text.
  //
  //   @marie sounds good       a reply to marie's card (after Reply, or any card of hers)
  //   @auth keep v1            the answer to what auth is waiting on: its card,
  //                            its picker (an option, or y / n), or its question
  //   @main, @main off         this session becomes main, or a working one again
  //   @restore [no|windows]    the restore offer
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)
    const text = e.text.trim()
    const m = /^@([\w.-]+)\s+([\s\S]+)$/.exec(text)
    if (m) {
      const who = m[1]!.toLowerCase()
      const open = (await read($, items)).filter(isCard)
      const it =
        (armed && armed.from.toLowerCase() === who ? open.find(i => i.id === armed!.id) : undefined) ??
        open.find(i => (i.from ?? '').toLowerCase() === who && !i.thread) ??
        open.find(i => (i.from ?? '').toLowerCase() === who && !open.some(o => (o.thread ?? '').toLowerCase() === who))
      if (it) {
        armed = null
        void reply($, it, m[2]!.trim())
        // A drop hands the text back to the box; clear it once that has happened.
        $.clock.after(150, () => $.prompt.fill({ text: '' }))
        return { drop: `crosstalk: reply to ${it.from}` }
      }
    }
    const at = parseAt(text)
    const all = await read($, items)
    const known = [...threadNames, ...all.map(i => i.thread ?? ''), ...all.filter(isCard).map(i => i.from ?? ''), ...(paneThread ? [paneThread] : [])].filter(Boolean)
    if (!at || !takesAt(at, known)) return next(e)
    void shortcut($, text)
    $.clock.after(150, () => $.prompt.fill({ text: '' }))
    return { drop: at.kind === 'name' ? `crosstalk: answer sent to ${at.name}` : `crosstalk: ${at.kind}` }
  }).catch(($, e, next) => (next.called ? next(e) : { drop: 'crosstalk: reply failed' }))

  // The agent's crosstalk_pane: the server answers it (saying nothing of what
  // the pane shows), and the pane opens here. It is the person's words behind
  // the call, so the pane is placed even on a narrow terminal where it can be.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    // crosstalk_qr too: its QR code is drawn in the pane (src/urls/history/phone.ts).
    if (/__crosstalk_(pane|qr)$/.test(e.tool) && !ran.deny && !ran.isError && interactive) {
      const thread = typeof (e as { thread?: unknown }).thread === 'string' ? ((e as { thread?: string }).thread as string) : undefined
      void openPane($, thread)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE_ID) {
      paneGen++
      paneThread = undefined
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Text, Link } = $.ui.resolve(e)
    const p = await read($, paneAtom)
    const problem = await read($, paneError)
    const now = await $.clock.now()
    const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, ' ')
    if (!p)
      return (
        <Box flexDirection="column">
          <Text dimColor>{clean(problem || 'loading the thread…')}</Text>
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
    return (
      <Box flexDirection="column">
        <Text wrap="truncate">
          <Text color={THREAD} bold>
            ◢ {clean(p.thread)}
          </Text>
          <Text dimColor> · {clean(p.status)}{p.sessions ? ` · ${p.sessions} session${p.sessions === 1 ? '' : 's'}` : ''}</Text>
        </Text>
        <Text wrap="truncate">{clean(p.people.join('  ') || 'nobody yet')}</Text>
        {p.recap ? (
          <Text dimColor wrap="wrap">
            {clean(p.recap)}
          </Text>
        ) : null}
        {p.qr ? (
          // For the phone (crosstalk_qr): white on black, so it scans on any terminal theme. Never model context.
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
        {section('Waiting', p.waiting.length ? p.waiting.map(w => `? ${w}`) : ['nothing'], 'w')}
        {p.decision ? section('Latest decision', [`${p.decision.text} (${p.decision.who}${p.decision.at ? `, ${ago(p.decision.at, now)}` : ''})`], 'd') : null}
        {p.features.length ? section('Features', p.features.map(featureLine), 'f') : null}
        {p.recent.length ? section('Recent', p.recent.map(r => `${r.from} ${ago(r.ts, now)} ${r.text}`), 'r') : null}
        {p.services?.length ? (
          <Box key="s" flexDirection="column" marginTop={1}>
            <Text bold>Services</Text>
            {p.services.map((s, i) => (
              <Text key={`s${i}`} wrap="truncate">
                {' '}
                {clean(s.name)}
                {s.broken ? <Text color="red">{` · broken: ${clean(s.broken)} `}</Text> : s.ports.length ? ` · ${s.ports.map(n => `:${n}`).join(' ')} ` : ' · starting'}
                {s.url && /^http:\/\/localhost:\d+$/.test(s.url) ? <Link href={s.url}>{s.url}</Link> : null}
              </Text>
            ))}
          </Box>
        ) : null}
        {p.shots?.length ? (
          // A mod cannot draw an image: each before and after is a file link (OSC 8) to open it.
          <Box key="sh" flexDirection="column" marginTop={1}>
            <Text bold>Screenshots</Text>
            {p.shots.map((s, i) => (
              <Box key={`sh${i}`} flexDirection="column">
                <Text wrap="truncate">
                  {' '}
                  {clean(shotLine(s, now))}
                </Text>
                {[...(s.before ? [{ w: 'before', f: s.before.file }] : []), { w: 'after ', f: s.after.file }].map(({ w, f }) => {
                  const href = fileLink(f)
                  return (
                    <Text key={`sh${i}${w}`} wrap="truncate" dimColor>
                      {'  '}
                      {w} {href ? <Link href={href}>{clean(f)}</Link> : clean(f)}
                    </Text>
                  )
                })}
              </Box>
            ))}
          </Box>
        ) : null}
        {p.links?.length ? (
          <Box key="l" flexDirection="column" marginTop={1}>
            <Text bold>Links</Text>
            {linkGroups(p.links).map(g => (
              <Box key={`l${g.kind}`} flexDirection="column">
                <Text dimColor> {g.title}</Text>
                {g.links.map((l, i) => (
                  <Text key={`l${g.kind}${i}`} wrap="truncate" dimColor={!l.alive}>
                    {'  '}
                    {clean(linkLine(l))}{' '}
                    {linkable(l.url) ? <Link href={l.url}>{l.url}</Link> : clean(l.url)}
                  </Text>
                ))}
              </Box>
            ))}
          </Box>
        ) : null}
        {problem ? <Text dimColor>{clean(problem)}</Text> : null}
      </Box>
    )
  })

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
    const digest = await read($, digestAtom)
    if (open.length === 0 && !digest) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const W = Math.max(24, Math.min(e.props.bodyColumns, CARD_MAX))
    const later = (it: Item) => (raisable(it) ? '' : ' · picker after your next turn')
    return (
      <Box flexDirection="column">
        {digest ? (
          <Text key="digest" wrap="truncate" dimColor>
            {digest.replace(/[\u0000-\u001f\u007f]/g, ' ')}
          </Text>
        ) : null}
        {open.map(it => {
          if (it.kind === 'invite')
            return (
              <Text key={it.id} wrap="truncate">
                <Text color={THREAD} bold>◢ invite</Text>
                <Text> {it.text ?? ''}</Text>
                <Text dimColor> · read the words to them; they work once, for fifteen minutes</Text>
              </Text>
            )
          if (it.kind === 'doctor')
            return (
              <Text key={it.id} wrap="truncate">
                <Text color={THREAD} bold>◢ crosstalk</Text>
                <Text dimColor>
                  {' '}
                  · {cut(oneLine((it.question ?? 'something is wrong').replace(/^crosstalk found /, 'found ')), 140)}{later(it)}
                </Text>
              </Text>
            )
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
          if (it.kind === 'cleanup')
            return (
              <Text key={it.id} wrap="truncate">
                <Text color={THREAD} bold>◢ clean up</Text>
                <Text dimColor>
                  {' '}
                  · {it.count ?? 0} finished worktree{it.count === 1 ? '' : 's'} · or say "clean up the worktrees"{later(it)}
                </Text>
              </Text>
            )
          if (it.kind === 'ship')
            return (
              <Text key={it.id} wrap="truncate">
                <Text color={THREAD} bold>◢ ship</Text>
                <Text dimColor>
                  {' '}
                  · {it.thread ? `${it.thread}: ` : ''}{cut(oneLine(it.question ?? 'a question for you'), 90)}{later(it)}
                </Text>
              </Text>
            )
          if (it.kind === 'thread')
            return (
              <Text key={it.id} wrap="truncate">
                <Text color={THREAD} bold>◢ thread</Text>
                <Text dimColor>
                  {' '}
                  · which thread is this session part of?{later(it)}
                </Text>
              </Text>
            )
          if (it.kind === 'rule' || it.kind === 'connect' || it.kind === 'conflict' || it.kind === 'disk' || it.kind === 'install')
            return (
              <Text key={it.id} wrap="truncate">
                <Text color={THREAD} bold>◢ {it.kind}</Text>
                <Text dimColor>
                  {' '}
                  · {it.kind === 'rule' ? 'always answer this way?' : it.kind === 'disk' ? 'free disk from finished threads?' : it.kind === 'install' ? `turn crosstalk on for everyone in ${it.thread ?? 'this repo'}?` : it.kind === 'connect' ? `connect with your team in ${it.thread ?? 'this repo'}?` : `who changes ${it.thread ?? 'it'}?`}
                  {later(it)}
                </Text>
              </Text>
            )
          if (it.kind === 'attention')
            return (
              <Text key={it.id} wrap="truncate">
                <Text color={THREAD} bold>◢ {it.from ?? it.thread ?? 'crosstalk'}</Text>
                <Text dimColor>
                  {' '}
                  · {cut(oneLine(it.question ?? 'a question for you'), 90)}
                  {later(it)}
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
