// crosstalk's mod: its $.state contract. Everything here is display state,
// rebuilt from the daemon after a restart; what was answered, handed over or
// muted is kept by crosstalk itself (src/uistate.ts), never here.

/** An attachment on a message, drawn as a chip: a label and a size. */
export type Chip = { kind: string; label: string; bytes?: number }

/** One thing waiting on the person, as `crosstalk ui watch` reports it. */
export type Item = {
  id: string
  kind: 'restore' | 'message' | 'ask' | 'route' | 'gather' | 'team' | 'cleanup' | 'thread' | 'ship' | 'rule' | 'connect' | 'conflict' | 'invite' | 'doctor' | 'disk' | 'install'
  sessionId: string
  state: 'pending' | 'answered' | 'handed' | 'muted' | 'later'
  createdAt: number
  updatedAt: number
  raisedAt?: number
  from?: string
  thread?: string
  text?: string
  chips?: Chip[]
  question?: string
  options?: string[]
  count?: number
  names?: string[]
  ts?: number
  /** A message about this session's own thread: handed to the agent without a picker. */
  auto?: boolean
}

/** A row the mod placed in the transcript for the person alone. */
export type Receipt = { id: string; text: string }

/** One feature in the pane: its risk, and where its flag stands. */
export type PaneFeature = { name: string; risk: string; flag?: string; stage?: string; state?: string }

/** A thread, as its pane draws it (src/ui-extra/pure.ts PaneModel). Never model context. */
export type Pane = {
  thread: string
  status: string
  repo?: string
  recap?: string
  people: string[]
  sessions: number
  waiting: string[]
  decision?: { text: string; who: string; at: number }
  recent: { from: string; text: string; ts?: number }[]
  features: PaneFeature[]
}

declare module 'claude-code' {
  interface PluginState {
    crosstalk: {
      items: Item[]
      receipts: Receipt[]
      /** The thread the pane shows, as `crosstalk ui pane` last printed it. */
      pane: Pane | null
      /** What the pane could not show, when it could not. */
      paneError: string
      /** The digest's one line at a pause; empty when there is none. */
      digest: string
    }
  }
}
