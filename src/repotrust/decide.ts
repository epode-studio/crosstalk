// Who is trusted through one repository, given what was found on its ref and
// what GitHub lists. Pure: no files, no network, so every case can be tested.
//
// Trust on first sight, then pin. The first time a login is seen, every
// statement that verifies against their GitHub keys is accepted, and those
// keys and crosstalk fingerprints are remembered. That is the cost the design
// accepts: for a collaborator you have never seen, you trust GitHub's key list.
// After that nothing changes silently:
//
//   same machine, same fingerprint          accepted (re-signed is fine)
//   same machine, new fingerprint           a question; the old one stays
//   new machine, signed by a pinned key     accepted: the same person, a new machine
//   new machine, signed by a key that was
//     added to GitHub since                 a question
//   a fingerprint that was revoked, back    a question
//   an older statement than the pinned one  ignored (a rollback is not an update)
//   a fingerprint you said no to            ignored
//   a pinned key removed from GitHub        everything it signed is revoked
//   a statement removed from the ref        revoked from this repository
//
// A key added to GitHub that has signed nothing changes nothing, so it is not
// worth a question; the question comes the moment it vouches for anything.
// Revocation needs evidence: a fresh answer from GitHub, or a fetch from the
// remote that succeeded. Being offline never takes trust away.

import type { Statement } from "./statement.ts"

export type Machine = {
  fingerprint: string
  edPub: string
  xPub: string
  created: number
  /** The SSH key that signed it, "type base64". */
  signer: string
}

export type Pin = {
  /** SSH keys accepted for this person. Only ever shrinks by itself; grows by a yes. */
  keys: string[]
  machines: Record<string, Machine>
  /** Fingerprints that were trusted and then revoked. Coming back is a question. */
  revoked: string[]
  /** Fingerprints the person said no to. Not asked about again. */
  rejected: string[]
}

export type Pins = Record<string, Pin>

/** A statement that verified against the login's current GitHub keys. */
export type Seen = { login: string; machine: string; statement: Statement; signer: string }

export type Member = { login: string; machine: string; fingerprint: string; edPub: string; xPub: string }

export type QuestionKind = "changed" | "new-key" | "returned"

export type Question = {
  id: string
  kind: QuestionKind
  login: string
  machine: string
  statement: Statement
  signer: string
  /** For "changed": the fingerprint that is still trusted meanwhile. */
  was?: string
}

export type Revoked = { login: string; machine: string; fingerprint: string; why: string }

export type Input = {
  pins: Pins
  /** Trusted through this repository after the previous sync, by "login/machine". */
  members: Record<string, Member>
  seen: Seen[]
  /** Per login: GitHub's keys, and whether that answer is fresh. Absent means nothing is known. */
  keys: Record<string, { keys: string[]; fresh: boolean } | undefined>
  /** The remote's refs were fetched just now, so absence on it means removal. */
  fetchOk: boolean
  /** "login/machine/fingerprint" still trusted through another repository. */
  elsewhere?: Set<string>
}

export type Output = {
  pins: Pins
  members: Record<string, Member>
  questions: Question[]
  revoked: Revoked[]
  /** Statements looked at and set aside, with why. */
  ignored: { login: string; machine: string; why: string }[]
  /** Logins seen for the first time in this run. */
  firstSight: string[]
}

export const questionId = (login: string, machine: string, fp: string) => `team:${login}/${machine}/${fp}`
export const memberKey = (login: string, machine: string) => `${login}/${machine}`

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const asMachine = (s: Statement, signer: string): Machine => ({
  fingerprint: s.fingerprint,
  edPub: s.edPub,
  xPub: s.xPub,
  created: s.created,
  signer,
})
const asMember = (login: string, machine: string, m: { fingerprint: string; edPub: string; xPub: string }): Member => ({
  login,
  machine,
  fingerprint: m.fingerprint,
  edPub: m.edPub,
  xPub: m.xPub,
})

export function decide(input: Input): Output {
  const pins = clone(input.pins)
  const members: Record<string, Member> = {}
  const questions: Question[] = []
  const revoked: Revoked[] = []
  const ignored: Output["ignored"] = []
  const firstSight: string[] = []
  const elsewhere = input.elsewhere ?? new Set<string>()

  const logins = new Set([...input.seen.map((s) => s.login), ...Object.values(input.members).map((m) => m.login)])

  for (const login of logins) {
    const ki = input.keys[login]
    const prevMembers = Object.values(input.members).filter((m) => m.login === login)
    if (!ki) {
      // Nothing known about their keys, not even from cache: no evidence either
      // way, so whatever was trusted stays trusted.
      for (const m of prevMembers) members[memberKey(login, m.machine)] = m
      continue
    }

    let pin = pins[login]
    const first = !pin
    if (!pin) {
      pin = pins[login] = { keys: [...ki.keys], machines: {}, revoked: [], rejected: [] }
      firstSight.push(login)
    }
    pin.revoked ??= []
    pin.rejected ??= []

    // A pinned key that GitHub no longer lists takes everything it signed with it.
    if (ki.fresh) {
      const now = new Set(ki.keys)
      pin.keys = pin.keys.filter((k) => now.has(k))
      for (const [machine, m] of Object.entries(pin.machines))
        if (!now.has(m.signer)) {
          delete pin.machines[machine]
          if (!pin.revoked.includes(m.fingerprint)) pin.revoked.push(m.fingerprint)
          revoked.push({ login, machine, fingerprint: m.fingerprint, why: "the SSH key that vouched for it was removed from their GitHub account" })
        }
    }

    const keepOld = new Set<string>() // machines whose old fingerprint stays while a question is open
    const present = new Set<string>()
    const seen = input.seen.filter((s) => s.login === login).sort((a, b) => b.statement.created - a.statement.created)

    for (const s of seen) {
      const { machine, statement: st, signer } = s
      if (present.has(machine)) continue
      const pinned = pin.machines[machine]
      if (pinned && pinned.fingerprint === st.fingerprint) {
        if (st.created >= pinned.created) pin.machines[machine] = asMachine(st, signer)
        members[memberKey(login, machine)] = asMember(login, machine, pin.machines[machine])
        present.add(machine)
        continue
      }
      if (pinned && st.created < pinned.created) {
        ignored.push({ login, machine, why: "older than the statement already trusted" })
        continue
      }
      if (pin.rejected.includes(st.fingerprint)) {
        ignored.push({ login, machine, why: "you said not to trust this key" })
        if (pinned) keepOld.add(machine)
        continue
      }
      if (first) {
        pin.machines[machine] = asMachine(st, signer)
        members[memberKey(login, machine)] = asMember(login, machine, st)
        present.add(machine)
        continue
      }
      const id = questionId(login, machine, st.fingerprint)
      if (pinned) {
        questions.push({ id, kind: "changed", login, machine, statement: st, signer, was: pinned.fingerprint })
        keepOld.add(machine)
        continue
      }
      if (pin.revoked.includes(st.fingerprint)) {
        questions.push({ id, kind: "returned", login, machine, statement: st, signer })
        continue
      }
      if (pin.keys.includes(signer)) {
        pin.machines[machine] = asMachine(st, signer)
        members[memberKey(login, machine)] = asMember(login, machine, st)
        present.add(machine)
        continue
      }
      questions.push({ id, kind: "new-key", login, machine, statement: st, signer })
    }

    for (const machine of keepOld) {
      const m = pin.machines[machine]
      if (m) {
        members[memberKey(login, machine)] = asMember(login, machine, m)
        present.add(machine)
      }
    }

    // Trusted here before, and gone from the ref now.
    for (const m of prevMembers) {
      if (present.has(m.machine)) continue
      const pinned = pin.machines[m.machine]
      if (!input.fetchOk) {
        if (pinned && pinned.fingerprint === m.fingerprint) members[memberKey(login, m.machine)] = m
        continue
      }
      if (revoked.some((r) => r.login === login && r.machine === m.machine)) continue
      if (pinned && pinned.fingerprint === m.fingerprint && !elsewhere.has(`${login}/${m.machine}/${m.fingerprint}`)) {
        delete pin.machines[m.machine]
        if (!pin.revoked.includes(m.fingerprint)) pin.revoked.push(m.fingerprint)
      }
      revoked.push({ login, machine: m.machine, fingerprint: m.fingerprint, why: "its statement was removed from the repository" })
    }
  }

  return { pins, members, questions, revoked, ignored, firstSight }
}

/**
 * Apply a person's answer to a question. A yes pins that fingerprint and the
 * key that signed it; a no remembers the fingerprint so it is not asked again.
 */
export function answer(pins: Pins, q: Question, trust: boolean): Pins {
  const out = clone(pins)
  const pin = (out[q.login] ??= { keys: [], machines: {}, revoked: [], rejected: [] })
  pin.revoked ??= []
  pin.rejected ??= []
  if (trust) {
    pin.machines[q.machine] = asMachine(q.statement, q.signer)
    if (!pin.keys.includes(q.signer)) pin.keys.push(q.signer)
    pin.revoked = pin.revoked.filter((f) => f !== q.statement.fingerprint)
    pin.rejected = pin.rejected.filter((f) => f !== q.statement.fingerprint)
  } else if (!pin.rejected.includes(q.statement.fingerprint)) pin.rejected.push(q.statement.fingerprint)
  return out
}
