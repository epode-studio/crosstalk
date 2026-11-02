// The repo-wide standing rules: RULES.md on refs/crosstalk/threads.
//
// One document per repository, shaped as a thread (src/threads/model.ts) that
// only holds notes of kind rule, so it merges with the same CRDT, is written
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
//   sig    the author's Ed25519 signature over the rule, its stamp and its
//          document: a rule (or its undoing) is taken from a frame or the
//          ref only when it verifies against the key of the fingerprint that
//          wrote it, so nobody who can merely push to the ref can plant a
//          rule, or put someone else's name on one.
//
// Who may change the rules: everyone in one of the repo's threads, never an
// agent. A RULES.md on the ref is read only when it is sealed and opens with
// our key or with a wrap one of those people wrote; a public one only when the
// rules are public here already. Keys move like a thread's (threads/rekey.ts):
// bound to the document and epoch inside each wrap, never back to a retired
// key or an older epoch, at most one epoch ahead.

import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { fingerprint, sign, verify } from "../crypto.ts"
import type { Identity, Peer } from "../config.ts"
import * as M from "../threads/model.ts"
import * as F from "../threads/format.ts"
import { newKey, unwrapFor, wrapKey } from "../threads/seal.ts"
import { adoption, check, retire, validKey } from "../threads/rekey.ts"

export const RULES_FILE = "RULES.md"

export type Rule = M.Item<M.Rule>

const ruleOf = (t: M.Thread | undefined, id: string): Rule | undefined => {
  const n = t?.notes[id]
  return n && n.kind === "rule" ? (n as Rule) : undefined
}

/** epochs and holders: the key's generation and who it may have reached (threads/rekey.ts). */
type State = {
  v: 1
  docs: Record<string, M.Thread>
  keys: Record<string, string>
  epochs?: Record<string, number>
  holders?: Record<string, string[]>
  /** Hashes of keys replaced here, never taken back (threads/rekey.ts). */
  retired?: Record<string, string[]>
}

/** What a rule's signature covers: the document, the item and its stamp. */
export const signedPart = (doc: string, r: Rule) =>
  M.canonical({ d: doc, id: r.id, l: r.l, by: r.by, text: r.text, who: r.who, at: r.at, when: r.when ?? null, then: r.then ?? null, gone: !!r.gone })

export const docId = (repo: string) => crypto.createHash("sha256").update(`crosstalk-rules:${repo}`).digest("hex").slice(0, 16)
export const ruleId = (key: string) => `r_${crypto.createHash("sha256").update(key).digest("hex").slice(0, 12)}`

export type Change = { added: Rule[]; removed: Rule[] }

export class RuleDocs {
  private st: State
  readonly me: string

  constructor(
    private d: {
      identity: Identity
      peers: () => Record<string, Peer>
      file: string
      now?: () => number
      /**
       * Who may change a repo's rules: the fingerprints of the people in its
       * threads, agents left out. Absent, anyone with a wrap for us may.
       */
      members?: (repo: string) => string[]
    },
  ) {
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
        return { v: 1, docs, keys: raw.keys ?? {}, epochs: raw.epochs ?? {}, holders: raw.holders ?? {}, retired: raw.retired ?? {} }
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
    return t ? M.notes(t, "rule") : []
  }

  /** The standing rule for a question's key, if there is one. */
  match(repo: string, key: string): Rule | undefined {
    return this.rules(repo).find((r) => r.when === key)
  }

  /** Who last wrote a rule, live or undone: the person who made or dropped it. */
  writer(repo: string, id: string): string | undefined {
    return ruleOf(this.st.docs[repo], id)?.by
  }

  isPublic = (repo: string) => !!this.st.docs[repo]?.meta.value.public

  add(repo: string, o: { key: string; then: string; text: string; who: string }): Rule {
    const t = this.doc(repo)
    const id = ruleId(o.key)
    M.put(t, "notes", id, { kind: "rule", text: o.text, who: o.who, at: this.now(), when: o.key, then: o.then }, this.me, this.now())
    this.signItem(repo, id)
    this.save()
    return ruleOf(t, id)!
  }

  /** Undo a rule, by id, by its key, or by words from its text when only one matches. */
  remove(repo: string | undefined, ref: string): { ok: true; rule: Rule; repo: string } | { ok: false; error: string } {
    const want = ref.trim().toLowerCase()
    const hits: { repo: string; r: Rule }[] = []
    for (const [rp, t] of Object.entries(this.st.docs)) {
      if (repo && rp !== repo) continue
      for (const r of M.notes(t, "rule"))
        if (r.id === ref || r.when === ref || (want && r.text.toLowerCase().includes(want))) hits.push({ repo: rp, r })
    }
    if (!hits.length) return { ok: false, error: `no standing rule matches "${ref}"` }
    if (hits.length > 1) return { ok: false, error: `more than one rule matches "${ref}": ${hits.map((h) => `${h.r.id} (${h.r.text})`).join("; ")}` }
    const { repo: rp, r } = hits[0]
    M.remove(this.st.docs[rp], "notes", r.id, this.me, this.now())
    this.signItem(rp, r.id)
    this.save()
    return { ok: true, rule: r, repo: rp }
  }

  setPublic(repo: string, pub: boolean): boolean {
    const changed = M.setMeta(this.doc(repo), this.me, { public: pub }, this.now())
    if (changed) this.save()
    return changed
  }

  /** Sign one rule item (made or undone here) with this machine's key. */
  private signItem(repo: string, id: string) {
    const t = this.st.docs[repo]
    const r = ruleOf(t, id)
    if (!t || !r) return
    const { sig: _s, ...rest } = r
    t.notes[id] = { ...rest, sig: sign(this.d.identity, signedPart(t.id, rest as Rule)) }
  }

  /** The Ed25519 key behind a fingerprint, as far as this machine knows. */
  private edPubOf(fp: string): string | undefined {
    if (fp === this.me) return this.d.identity.ed.pub
    return Object.values(this.d.peers()).find((p) => p.fingerprint === fp)?.edPub
  }

  /** A rule item whose signature is its author's. */
  verified(doc: string, r: Rule): boolean {
    const sig = (r as Rule & { sig?: string }).sig
    const pub = this.edPubOf(r.by)
    if (!sig || !pub) return false
    const { sig: _s, ...rest } = r as Rule & { sig?: string }
    return verify(pub, signedPart(doc, rest as Rule), sig)
  }

  /** Who may change this repo's rules, or undefined for anyone. */
  private allowed(repo: string): Set<string> | undefined {
    if (!this.d.members) return undefined
    const bots = new Set(Object.values(this.d.peers()).filter((p) => p.isMachine).map((p) => p.fingerprint))
    return new Set([...this.d.members(repo), this.me].filter((fp) => !bots.has(fp)))
  }

  /**
   * Merge another replica in. Returns the rules that appeared and went.
   *
   * Only rule items signed by their author, and by someone allowed to change
   * this repo's rules, are taken; anything else in `inc` is left out. Whether
   * the rules are public is decided here, never by the other replica. A key
   * comes in only as rekey.ts adoption allows; `wrapped` is who a file wrapped
   * it for, which counts toward who may hold it.
   */
  merge(repo: string, inc: M.Thread, key?: string, epoch = 0, wrapped: string[] = []): Change {
    if (inc.id !== docId(repo)) return { added: [], removed: [] }
    const allowed = this.allowed(repo)
    if (validKey(key)) {
      const e = adoption({ key: this.st.keys[repo], epoch: this.epoch(repo), retired: this.st.retired?.[repo] }, { key, epoch })
      if (e !== null) {
        ;(this.st.retired ??= {})[repo] = retire(this.st.retired[repo], this.st.keys[repo])
        this.st.keys[repo] = key
        if (e) (this.st.epochs ??= {})[repo] = e
        else delete this.st.epochs?.[repo]
        // Who it may have reached: whoever it was wrapped for, and everyone allowed to read it.
        ;(this.st.holders ??= {})[repo] = [...new Set([...wrapped, ...(allowed ?? []), this.me])].sort()
        this.save()
      }
    }
    const known = this.st.docs[repo]
    // Rules only: any other note in the document is no rule and is left out.
    const notes: M.Items<M.Note> = {}
    for (const id of Object.keys(inc.notes)) {
      const r = ruleOf(inc, id)
      const mine = ruleOf(known, id)
      const ok = !!r && this.verified(inc.id, r) && (!allowed || allowed.has(r.by))
      if (ok) notes[id] = r
      else if (mine) notes[id] = mine
    }
    const screened: M.Thread = { ...inc, notes, meta: { ...inc.meta, value: { ...inc.meta.value, public: known ? known.meta.value.public : false } } }
    const before = new Map((known ? M.notes(known, "rule") : []).map((r) => [r.id, r]))
    const merged = known ? M.merge(known, screened) : screened
    merged.people = {}
    if (known) merged.meta = { ...merged.meta, value: { ...merged.meta.value, public: known.meta.value.public } }
    if (known && M.same(known, merged)) return { added: [], removed: [] }
    this.st.docs[repo] = merged
    this.save()
    const after = new Map(M.notes(merged, "rule").map((r) => [r.id, r]))
    return {
      added: [...after.values()].filter((r) => !before.has(r.id)),
      removed: [...before.values()].filter((r) => !after.has(r.id)),
    }
  }

  /** What travels over the relay. */
  frame(repo: string): { repo: string; doc: M.Thread; key?: string } | undefined {
    const t = this.st.docs[repo]
    return t ? { repo, doc: t, key: this.st.keys[repo], ...(this.epoch(repo) ? { epoch: this.epoch(repo) } : {}) } : undefined
  }

  epoch = (repo: string) => this.st.epochs?.[repo] ?? 0

  /**
   * A new key when someone who may hold this one is no longer among `should`
   * (everyone in the repo's threads, minus revoked keys). True when it changed:
   * the caller sends the rules again, and RULES.md is re-sealed on the commit.
   */
  ensureKey(repo: string, should: string[]): boolean {
    if (!this.st.docs[repo] || this.st.docs[repo].meta.value.public || !this.st.keys[repo]) return false
    const holders = (this.st.holders ??= {})
    const r = check({ me: this.me, holders: holders[repo], should: [...new Set([...should, this.me])].sort() })
    const same = M.canonical(holders[repo]) === M.canonical(r.holders)
    holders[repo] = r.holders
    if (!r.rotate) {
      if (!same) this.save()
      return false
    }
    ;(this.st.retired ??= {})[repo] = retire(this.st.retired[repo], this.st.keys[repo])
    this.st.keys[repo] = newKey().toString("base64")
    ;(this.st.epochs ??= {})[repo] = this.epoch(repo) + 1
    this.save()
    return true
  }

  /** RULES.md for this repo, sealed to `recipients` unless the rules were made public. */
  render(repo: string, recipients: Peer[]): string | undefined {
    const t = this.st.docs[repo]
    if (!t) return undefined
    if (t.meta.value.public) return F.renderPublic(t)
    const k = this.st.keys[repo]
    if (!k) return undefined
    const key = Buffer.from(k, "base64")
    return F.renderSealed(t, key, wrapKey(this.d.identity, key, recipients, { thread: t.id, epoch: this.epoch(repo) }), this.epoch(repo))
  }

  /**
   * RULES.md as read from the ref. A copy nobody gave us the key to changes
   * nothing, and neither does a public copy while the rules are sealed here,
   * or a sealed one whose only wrap for us is from someone not allowed to
   * change them.
   */
  read(repo: string, text: string): Change {
    const p = F.parse(text)
    let t: M.Thread | null = null
    let key: string | undefined
    let epoch = 0
    let wrapped: string[] = []
    if (p.kind === "public") {
      if (!this.isPublic(repo)) return { added: [], removed: [] }
      t = p.thread
    } else if (p.kind === "sealed") {
      const mine = this.st.keys[repo]
      t = mine ? p.open(Buffer.from(mine, "base64")) : null
      if (!t) {
        const u = unwrapFor(this.d.identity, p.wraps, Object.values(this.d.peers()), docId(repo), this.allowed(repo))
        t = u ? p.open(u.key) : null
        if (t && u) {
          key = u.key.toString("base64")
          epoch = u.epoch
          wrapped = p.wraps.map((w) => w.to)
          // A key we would not adopt opens nothing: what it sealed is not taken either.
          if (adoption({ key: mine, epoch: this.epoch(repo), retired: this.st.retired?.[repo] }, { key, epoch }) === null) return { added: [], removed: [] }
        }
      }
    }
    if (!t) return { added: [], removed: [] }
    return this.merge(repo, t, key, epoch, wrapped)
  }
}
