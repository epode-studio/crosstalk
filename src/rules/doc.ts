// The repo-wide standing rules: RULES.md on refs/crosstalk/threads.
//
// One document per repository, shaped as a thread (src/threads/model.ts) that
// only uses its `rules` section, so it merges with the same CRDT, is written
// with the same format (sealed section by section, or public markdown) and is
// sealed to the same people: everyone in a thread of that repo. It is never a
// thread anywhere else: it is kept here, not in the thread service, and no
// session is ever placed in it.
//
// A rule's id is a hash of its key, so two people making the same rule at once
// make one rule, and undoing it is a tombstone that wins over a stale copy.
//
//   when   the question's key (key.ts)
//   then   the standing answer
//   text   the rule in words, for the digest and RULES.md

import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { fingerprint } from "../crypto.ts"
import type { Identity, Peer } from "../config.ts"
import * as M from "../threads/model.ts"
import * as F from "../threads/format.ts"
import { newKey, unwrapKey, wrapKey } from "../threads/seal.ts"

export const RULES_FILE = "RULES.md"

export type Rule = M.Item<M.Rule>

type State = { v: 1; docs: Record<string, M.Thread>; keys: Record<string, string> }

export const docId = (repo: string) => crypto.createHash("sha256").update(`crosstalk-rules:${repo}`).digest("hex").slice(0, 16)
export const ruleId = (key: string) => `r_${crypto.createHash("sha256").update(key).digest("hex").slice(0, 12)}`

export type Change = { added: Rule[]; removed: Rule[] }

export class RuleDocs {
  private st: State
  readonly me: string

  constructor(private d: { identity: Identity; peers: () => Record<string, Peer>; file: string; now?: () => number }) {
    this.me = fingerprint(d.identity.ed.pub)
    this.st = this.load()
  }

  private now = () => (this.d.now ? this.d.now() : Date.now())

  private load(): State {
    try {
      const raw = JSON.parse(fs.readFileSync(this.d.file, "utf8"))
      if (raw?.v === 1) {
        const docs: Record<string, M.Thread> = {}
        for (const [repo, t] of Object.entries(raw.docs ?? {})) {
          const ok = M.parseThread(t)
          if (ok) docs[repo] = ok
        }
        return { v: 1, docs, keys: raw.keys ?? {} }
      }
    } catch {}
    return { v: 1, docs: {}, keys: {} }
  }

  private save() {
    fs.mkdirSync(path.dirname(this.d.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.d.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.st), { mode: 0o600 })
    fs.renameSync(tmp, this.d.file)
  }

  repos = () => Object.keys(this.st.docs)

  private doc(repo: string): M.Thread {
    let t = this.st.docs[repo]
    if (!t) {
      t = M.create({ id: docId(repo), name: "rules", repo, by: this.me, label: this.d.identity.label, now: this.now() })
      // Nobody is "in" the rules: who reads them is everyone in the repo's threads.
      t.people = {}
      this.st.docs[repo] = t
      this.st.keys[repo] ??= newKey().toString("base64")
    }
    return t
  }

  rules(repo: string): Rule[] {
    const t = this.st.docs[repo]
    return t ? (M.live(t, "rules") as Rule[]) : []
  }

  /** The standing rule for a question's key, if there is one. */
  match(repo: string, key: string): Rule | undefined {
    return this.rules(repo).find((r) => r.when === key)
  }

  /** Who last wrote a rule, live or undone: the person who made or dropped it. */
  writer(repo: string, id: string): string | undefined {
    return this.st.docs[repo]?.rules[id]?.by
  }

  isPublic = (repo: string) => !!this.st.docs[repo]?.meta.value.public

  add(repo: string, o: { key: string; then: string; text: string; who: string }): Rule {
    const t = this.doc(repo)
    const id = ruleId(o.key)
    M.put(t, "rules", id, { text: o.text, who: o.who, at: this.now(), when: o.key, then: o.then }, this.me, this.now())
    this.save()
    return t.rules[id] as Rule
  }

  /** Undo a rule, by id, by its key, or by words from its text when only one matches. */
  remove(repo: string | undefined, ref: string): { ok: true; rule: Rule; repo: string } | { ok: false; error: string } {
    const want = ref.trim().toLowerCase()
    const hits: { repo: string; r: Rule }[] = []
    for (const [rp, t] of Object.entries(this.st.docs)) {
      if (repo && rp !== repo) continue
      for (const r of M.live(t, "rules") as Rule[])
        if (r.id === ref || r.when === ref || (want && r.text.toLowerCase().includes(want))) hits.push({ repo: rp, r })
    }
    if (!hits.length) return { ok: false, error: `no standing rule matches "${ref}"` }
    if (hits.length > 1) return { ok: false, error: `more than one rule matches "${ref}": ${hits.map((h) => `${h.r.id} (${h.r.text})`).join("; ")}` }
    const { repo: rp, r } = hits[0]
    M.remove(this.st.docs[rp], "rules", r.id, this.me, this.now())
    this.save()
    return { ok: true, rule: r, repo: rp }
  }

  setPublic(repo: string, pub: boolean): boolean {
    const changed = M.setMeta(this.doc(repo), this.me, { public: pub }, this.now())
    if (changed) this.save()
    return changed
  }

  /** Merge another replica in. Returns the rules that appeared and went. */
  merge(repo: string, inc: M.Thread, key?: string): Change {
    if (inc.id !== docId(repo)) return { added: [], removed: [] }
    if (key && Buffer.from(key, "base64").length === 32) {
      const mine = this.st.keys[repo]
      if (!mine || key < mine) this.st.keys[repo] = key
    }
    const known = this.st.docs[repo]
    const before = new Map((known ? (M.live(known, "rules") as Rule[]) : []).map((r) => [r.id, r]))
    const merged = known ? M.merge(known, inc) : inc
    merged.people = {}
    if (known && M.same(known, merged)) return { added: [], removed: [] }
    this.st.docs[repo] = merged
    this.save()
    const after = new Map((M.live(merged, "rules") as Rule[]).map((r) => [r.id, r]))
    return {
      added: [...after.values()].filter((r) => !before.has(r.id)),
      removed: [...before.values()].filter((r) => !after.has(r.id)),
    }
  }

  /** What travels over the relay. */
  frame(repo: string): { repo: string; doc: M.Thread; key?: string } | undefined {
    const t = this.st.docs[repo]
    return t ? { repo, doc: t, key: this.st.keys[repo] } : undefined
  }

  /** RULES.md for this repo, sealed to `recipients` unless the rules were made public. */
  render(repo: string, recipients: Peer[]): string | undefined {
    const t = this.st.docs[repo]
    if (!t) return undefined
    if (t.meta.value.public) return F.renderPublic(t)
    const k = this.st.keys[repo]
    if (!k) return undefined
    const key = Buffer.from(k, "base64")
    return F.renderSealed(t, key, wrapKey(this.d.identity, key, recipients))
  }

  /** RULES.md as read from the ref. A copy nobody gave us the key to changes nothing. */
  read(repo: string, text: string): Change {
    const p = F.parse(text)
    let t: M.Thread | null = null
    let key: string | undefined
    if (p.kind === "public") t = p.thread
    else if (p.kind === "sealed") {
      const mine = this.st.keys[repo]
      t = mine ? p.open(Buffer.from(mine, "base64")) : null
      if (!t) {
        const k = unwrapKey(this.d.identity, p.wraps, Object.values(this.d.peers()))
        t = k ? p.open(k) : null
        if (t && k) key = k.toString("base64")
      }
    }
    if (!t) return { added: [], removed: [] }
    return this.merge(repo, t, key)
  }
}
