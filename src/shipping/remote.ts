// Shipping questions answered from another person's machine.
//
// A shipping question is asked on the machine running the feature (its
// engine holds the feature's state), and it is also a thread item, so it
// reaches everyone in the thread the way every item does: over the relay,
// sealed pairwise, and on the ref, sealed to the thread's people. The item
// carries what a person elsewhere needs to answer it (`ship`: its kind, its
// options, which machine asked).
//
// On another machine, a person answers it the same two ways as at home (the
// picker, or `crosstalk ship answer` typed in a terminal; never an agent's
// tool call, never a rule). Their daemon writes the pick onto the item as a
// `vote`, signed with that person's identity key. The asking machine takes a
// vote only when all of these hold:
//
//   the signature is good, under the key of
//   someone this machine trusts (a direct peer, or one trusted through the repo),
//   who is a person (a peer marked as a machine never answers these),
//   and is in the thread,
//   for one of the question's options.
//
// Anything else is ignored and logged. The item's `answer`, which anyone in
// the thread could write, is never read as an answer: only a good vote is.

import { sign, verify, fingerprint } from "../crypto.ts"
import type { Identity, Peer } from "../config.ts"
import type { Thread } from "../threads/model.ts"
import * as M from "../threads/model.ts"

export type Vote = NonNullable<M.Question["vote"]>

export const payload = (thread: string, question: string, pick: string, at: number) => `crosstalk/ship-answer/v1\n${thread}\n${question}\n${pick}\n${at}`

export function signVote(id: Identity, thread: string, question: string, pick: string, at: number): Vote {
  return { pick, fp: fingerprint(id.ed.pub), label: id.label, at, sig: sign(id, payload(thread, question, pick, at)) }
}

export type Checked = { ok: true; who: string } | { ok: false; why: string }

/** Whether a vote on a question this machine asked may answer it. */
export function checkVote(o: { thread: Thread; question: string; vote: Vote; options: string[]; me: string; peers: Peer[] }): Checked {
  const { vote, thread } = o
  if (!vote || typeof vote.pick !== "string" || typeof vote.fp !== "string" || typeof vote.sig !== "string") return { ok: false, why: "malformed" }
  if (vote.fp === o.me) return { ok: false, why: "that is this machine's own identity; answer here instead" }
  const peer = o.peers.find((p) => p.fingerprint === vote.fp)
  if (!peer) return { ok: false, why: `${vote.label ?? vote.fp} is not someone this machine trusts` }
  if (fingerprint(peer.edPub) !== vote.fp) return { ok: false, why: "the key does not match its fingerprint" }
  if (peer.isMachine) return { ok: false, why: `${peer.label} is not a person` }
  if (!M.people(thread).includes(vote.fp)) return { ok: false, why: `${peer.label} is not in the thread` }
  if (!o.options.includes(vote.pick)) return { ok: false, why: `"${vote.pick}" is not one of the options` }
  if (!verify(peer.edPub, payload(thread.id, o.question, vote.pick, vote.at), vote.sig)) return { ok: false, why: "the signature does not verify" }
  return { ok: true, who: peer.label }
}
