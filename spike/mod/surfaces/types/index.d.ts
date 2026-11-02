/** An attachment chip on a card: a label and a size, fetched only when opened. */
export type Chip = { kind: string; label: string; size: string }

/** A message from another thread, drawn as a card in the band. */
export type Card = { id: string; from: string; thread: string; age: string; text: string; chip?: Chip }

/** What the thread pane shows. */
export type Thread = {
  name: string
  status: string
  people: { name: string; online: boolean }[]
  waiting: string[]
  decision: string
  recent: { from: string; text: string; age: string }[]
}

declare module 'claude-code' {
  interface PluginState {
    'crosstalk-surfaces': { cards: Card[]; done: string[]; thread: Thread | null }
  }
}
