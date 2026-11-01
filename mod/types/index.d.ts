// crosstalk's mod: its $.state contract. Everything here is display state,
// rebuilt from the daemon after a restart; what was answered, handed over or
// muted is kept by crosstalk itself (src/uistate.ts), never here.

/** An attachment on a message, drawn as a chip: a label and a size. */
export type Chip = { kind: string; label: string; bytes?: number }

/** One thing waiting on the person, as `crosstalk ui watch` reports it. */
export type Item = {
  id: string
  kind: 'restore' | 'message' | 'ask' | 'route' | 'gather' | 'cleanup'
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
}

/** A row the mod placed in the transcript for the person alone. */
export type Receipt = { id: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    crosstalk: { items: Item[]; receipts: Receipt[] }
  }
}
