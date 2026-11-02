// Re-keying when someone leaves (docs/design/next-generation.md, "Still open",
// keys for many threads).
//
// A thread's content key (seal.ts) is wrapped for its people. Taking someone
// out of the wraps is not enough: they already hold the key, and every
// section sealed under it later would still open for them. So whenever a
// person who could hold the current key is no longer one who should, the key
// is replaced:
//
//   should hold   the thread's live people, minus anyone whose crosstalk key
//                 repo trust revoked (repotrust pins[*].revoked)
//   holders       everyone the current key may have reached: whoever should
//                 hold it at any moment since it was made or adopted
//   rotate        some holder no longer should, and we still do: a new random
//                 key, one epoch up, wrapped only for who should hold it
//
// The new key travels like the old one (the thread frame, sealed pairwise to
// each person) and seals every section on the next commit, so the ref's newest
// file does not open with the old key. Old commits are not rewritten: whoever
// held the old key can still read the history they could read before. That is
// stated in docs/security.md; it is the honest limit of sealing data that was
// already handed over.
//
// Two people may rotate at once. Keys converge on the higher epoch, then on
// the smaller key, so every replica ends with the same one and a stale replica
// can never put an old key back.

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { ROOT } from "../config.ts"
import * as M from "./model.ts"

/** A person's tombstone that also says they were taken out, so nobody's presence brings them back in. */
export type Removed = M.Item<M.Person> & { removed?: true }

export const isRemoved = (t: M.Thread, fp: string) => {
  const p = t.people[fp] as Removed | undefined
  return !!(p && p.gone && p.removed)
}

/** Take someone out of a thread: their person entry and their sessions. */
export function removePerson(t: M.Thread, fp: string, by: string, now = Date.now()): boolean {
  let changed = M.remove(t, "people", fp, by, now)
  const p = t.people[fp] as Removed | undefined
  if (p && p.gone && !p.removed) {
    p.removed = true
    changed = true
  }
  for (const s of M.live(t, "sessions")) if (s.person === fp) changed = M.remove(t, "sessions", s.id, by, now) || changed
  return changed
}

/** Fingerprints repo trust revoked, on any repo. */
export function revokedFingerprints(root = ROOT): Set<string> {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(root, "repotrust", "state.json"), "utf8"))
    const out = new Set<string>()
    for (const pin of Object.values(s?.pins ?? {}) as any[]) for (const fp of pin?.revoked ?? []) if (typeof fp === "string") out.add(fp)
    return out
  } catch {
    return new Set()
  }
}

export function shouldHold(people: string[], revoked: Set<string>): string[] {
  return [...new Set(people)].filter((fp) => !revoked.has(fp)).sort()
}

/**
 * What to do with the current key. `holders` undefined is a key from before
 * this was tracked: it is taken to have reached exactly who should hold it.
 */
export function check(o: { me: string; holders?: string[]; should: string[] }): { rotate: boolean; holders: string[] } {
  if (!o.holders) return { rotate: false, holders: o.should }
  const should = new Set(o.should)
  const gone = o.holders.filter((h) => !should.has(h))
  if (gone.length && should.has(o.me)) return { rotate: true, holders: o.should }
  return { rotate: false, holders: [...new Set([...o.holders, ...o.should])].sort() }
}

/** True when the incoming key should replace ours: a higher epoch, or the same epoch and a smaller key. */
export function wins(mine: { key?: string; epoch?: number }, theirs: { key: string; epoch?: number }): boolean {
  const a = mine.epoch ?? 0
  const b = theirs.epoch ?? 0
  if (!mine.key) return true
  if (b !== a) return b > a
  return theirs.key < mine.key
}

/** A short hash of a key: what is remembered of a key once it is retired. */
export const keyHash = (k: string) => crypto.createHash("sha256").update(Buffer.from(k, "base64")).digest("hex").slice(0, 32)

/**
 * Whether a key offered by a peer's frame or found in a file may replace ours,
 * and the epoch it is kept at; null when it may not. The epoch it claims is
 * only believed within limits, since whoever offers it may have held the key
 * once and kept it:
 *
 *   - never a key this replica retired (its hash is kept), whatever its epoch;
 *   - never an epoch below the one held: keys only move forward;
 *   - at most one epoch ahead: a claim of 2^53 is kept as ours + 1, so the
 *     next rotation here still goes past it;
 *   - otherwise as wins() says.
 */
export function adoption(mine: { key?: string; epoch?: number; retired?: string[] }, theirs: { key: string; epoch?: number }): number | null {
  const a = mine.epoch ?? 0
  const claimed = theirs.epoch ?? 0
  if (!Number.isSafeInteger(claimed) || claimed < 0) return null
  if (mine.retired?.includes(keyHash(theirs.key))) return null
  if (!mine.key) return Math.min(claimed, a + 1)
  if (theirs.key === mine.key || claimed < a) return null
  const b = Math.min(claimed, a + 1)
  return wins(mine, { key: theirs.key, epoch: b }) ? b : null
}

/** The retired list with one more key in it, bounded. */
export const retire = (list: string[] | undefined, key: string | undefined) =>
  key ? [...new Set([...(list ?? []), keyHash(key)])].slice(-64) : list ?? []

export const validKey = (k: unknown): k is string => typeof k === "string" && Buffer.from(k, "base64").length === 32
