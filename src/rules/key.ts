// What makes two questions "the same kind of question" (docs/design/
// next-generation.md, "Answers become rules").
//
// A key names the kind of question and its topic, and nothing about which
// thread or session asked it, so the same question from two threads, two
// sessions or two people is one key:
//
//   route    sender=marie repo=github.com/acme/api
//   thread   repo=github.com/acme/api among=auth,billing
//   ask      sender=marie text=can i merge the token change
//   question text=use the v# token format for new endpoints
//
// Some questions are never answered by a rule, however often the answer was
// the same: a key that changed (trust is decided each time), anything about a
// risky feature, and anything that deletes.

export type QuestionKind = "route" | "thread" | "ask" | "question" | "team"

export type Question = {
  kind: QuestionKind
  repo?: string
  sender?: string
  text?: string
  /** thread: the threads it was between. */
  among?: string[]
  /** Set by the caller when the question is about a feature marked risky. */
  risky?: boolean
}

/** Lower case, no punctuation, numbers as #, one space: what a person would call the same words. */
export function normaliseText(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[`'"“”‘’]/g, "")
    .replace(/[0-9]+/g, "#")
    .replace(/[^a-z#\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200)
}

export const normaliseAnswer = (s: string) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!]+$/, "")
    .slice(0, 200)

const word = (s: string | undefined) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, "-")

export function ruleKey(q: Question): string {
  switch (q.kind) {
    case "route":
      return `route sender=${word(q.sender)} repo=${word(q.repo)}`
    case "thread":
      return `thread repo=${word(q.repo)} among=${[...(q.among ?? [])].map(word).sort().join(",")}`
    case "ask":
      return `ask sender=${word(q.sender)} text=${normaliseText(q.text ?? "")}`
    case "team":
      return `team sender=${word(q.sender)}`
    default:
      return `question text=${normaliseText(q.text ?? "")}`
  }
}

const DELETION = /\b(delet\w*|remov\w*|drop(s|ped|ping)?|destroy\w*|wip(e|es|ed|ing)|purg\w*|eras\w*|truncat\w*|rm|force[- ]push\w*|reset --hard)\b/i
const RISKY = /\b(risky|risk|feature flags?|flags?|rollout|production|prod)\b/i

/** Why a question may never be answered by a rule, or null when it may. */
export function neverAuto(q: Question, answer?: string): string | null {
  if (q.kind === "team") return "a key that changed is decided each time"
  if (q.risky) return "it is about a risky feature"
  const text = `${q.text ?? ""} ${answer ?? ""}`
  if (DELETION.test(text)) return "it deletes something"
  if (RISKY.test(text)) return "it is about a risky feature"
  return null
}

/** The question in words, for an offer or a digest line. */
export function describe(q: Question): string {
  switch (q.kind) {
    case "route":
      return `where ${q.sender}'s messages about ${q.repo || "this repo"} go`
    case "thread":
      return `which of ${(q.among ?? []).join(" and ")} a session belongs to`
    case "ask":
      return `${q.sender} asking "${(q.text ?? "").slice(0, 80)}"`
    default:
      return `"${(q.text ?? "").slice(0, 80)}"`
  }
}
