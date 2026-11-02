// Notes: everything crosstalk knows, in one list (docs/design/next-generation.md,
// "Three nouns"). A thread's notes are one list in the thread itself
// (src/threads/model.ts). Facts and tasks kept with the people you joined with
// words, outside any thread (src/facts.ts, src/tasks.ts), are the same thing
// to whoever reads them: they come out of here in the same shape, marked with
// whom they are kept, so the `thread` tool lists them with the rest.

import * as M from "./threads/model.ts"
import * as facts from "./facts.ts"
import * as tasks from "./tasks.ts"

/** A note as the `thread` tool lists it: a thread's, or one kept with people you joined with words. */
export type ListedNote = M.NoteView & { thread?: string; with?: string; ended?: boolean }

/** A thread's notes, the recap aside (read it as `recap`). */
export function threadNotes(t: M.Thread, kinds?: readonly M.NoteKind[]): ListedNote[] {
  const want = kinds?.length ? kinds : (["decision", "fact", "task", "rule"] as const)
  return M.notes(t, want).map((n) => ({ ...M.noteView(n), thread: t.meta.value.name }))
}

/**
 * Facts and open tasks kept with each group of people joined with words, keyed
 * by the group's name inside crosstalk (a room's, or a direct peer's label).
 * `with` is that name, which an edit of one of them names as `room`.
 */
export function groupNotes(groups: readonly string[], o: { facts?: facts.FactStore; tasks?: tasks.TaskStore; kinds?: readonly M.NoteKind[] } = {}): ListedNote[] {
  const want = new Set(o.kinds?.length ? o.kinds : ["fact", "task"])
  const fs = o.facts ?? facts.load()
  const ts = o.tasks ?? tasks.load()
  const out: ListedNote[] = []
  for (const g of new Set(groups)) {
    if (want.has("fact"))
      for (const f of facts.liveFacts(g, fs))
        out.push({ id: f.id, kind: "fact", text: f.text, who: f.by, at: f.at, ...(f.confirmed.length ? { confirmed: f.confirmed.map((c) => c.by) } : {}), with: g })
    if (want.has("task"))
      for (const k of tasks.openTasks(g, ts))
        out.push({ id: k.id, kind: "task", text: k.text, who: k.by, at: k.at, state: k.state, ...(k.claimedBy ? { claimedBy: k.claimedBy } : {}), with: g })
  }
  return out.sort((a, b) => a.at - b.at)
}

/** A confirmation on a thread's fact: who stands behind it now, with when. Undefined when there is no such fact. */
export function confirmed(t: M.Thread, id: string, who: string, at: number): M.Data<M.Item<M.Fact>> | undefined {
  const f = M.noteOf(t, id, "fact")
  if (!f) return undefined
  const { l: _l, by: _b, id: _i, gone: _g, ...data } = f
  return { ...data, confirmed: [...(data.confirmed ?? []).filter((c) => c.by !== who), { by: who, at }] }
}
