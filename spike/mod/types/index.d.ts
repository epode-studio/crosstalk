/** A question another thread is blocked on, as the spike's JSON file lists it. */
export type Question = { id: string; thread: string; text: string; toast?: string }

/** A peer delivery the mod took in `session.receive`, shown instead of queued. */
export type Peer = { at: number; origin: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    'crosstalk-spike': { questions: Question[]; answered: string[]; peers: Peer[] }
  }
}
