// Where the once-per-repo question (index.ts) goes: the mod's picker when the
// mod runs in the session, else a systemMessage the agent answers with
// crosstalk_people action "env". Exactly one of the two.

import * as ui from "../uistate.ts"
import { NO, YES, type Prepared } from "./index.ts"

export const sayText = (question: string) => `◢ crosstalk: ${question} Say "copy them" or "not in this repo"; the agent answers with crosstalk_people action "env".`

export function surface(offer: NonNullable<Prepared["offer"]>, sessionId: string | undefined, mod = !!sessionId && ui.modActive(sessionId)): { systemMessage?: string; picker?: boolean } {
  const text = sayText(offer.question)
  if (!mod || !sessionId) return { systemMessage: text }
  try {
    ui.withStore((items, now) => ui.upsert(items, { id: offer.id, kind: "env", sessionId, thread: offer.name, question: offer.question, options: [YES, NO], ts: now }, now))
    return { picker: true }
  } catch {
    return { systemMessage: text }
  }
}

/** Once answered (here or in the picker), the picker goes. */
export function settle(id: string) {
  try {
    ui.withStore((items, now) => ui.settle(items, id, "answered", now))
  } catch {}
}
