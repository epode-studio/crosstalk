// What shipping keeps on a thread's feature, so it travels with the thread to
// its people and onto the ref like everything else ("One place").
//
// docs/design/next-generation.md, "Shipping". Every field is optional: a
// feature written before shipping existed, or by hand, has none of them.

export type ShipState =
  /** Declared; the author is still working. */
  | "building"
  /** Reviewers are on it. */
  | "reviewing"
  /** The reviewers asked for changes; the author has the findings. */
  | "changes"
  /** Author and reviewer could not settle it in N rounds; a question is out. */
  | "disagree"
  /** Signed off; checks next. */
  | "approved"
  /** The test command failed on the branch. */
  | "red"
  /** Risky and signed off, waiting for the author's evidence of behaviour. */
  | "needs-evidence"
  /** Risky, green, signed off, evidence attached: the merge question is out. */
  | "awaiting-merge"
  /** A PR is open and set to merge itself. */
  | "pr-open"
  /** In the default branch. Behind its flag when it has one. */
  | "merged"
  /** Its flag is fully on. */
  | "shipped"
  /** Could not merge (conflict, a dirty checkout, a rejected push); the author has the reason. */
  | "blocked"

/** Evidence of behaviour, in plain language. Never a diff. */
export type Evidence = {
  summary: string
  tests?: string[]
  evals?: string[]
  before_after?: { before: string; after: string }[]
  screenshots?: string[]
  /** Which flag stage it is evidence for: "merge" before merging, else the stage it was gathered at. */
  stage: string
  who: string
  at: number
}

export type Signoff = { by: string; kind: ReviewKind; client: string; round: number; at: number }

export type ReviewKind = "review" | "adversarial" | "security"

export type FeatureShip = {
  state?: ShipState
  /** The branch the work is on. */
  branch?: string
  /** Why it is risky, when it is: the rule it matched, or the agent's reason. */
  why?: string
  round?: number
  signoff?: Signoff[]
  evidence?: Evidence[]
  merged?: { sha: string; at: number; files: string[]; shas: string[]; how: string; pr?: string }
  /** Where its flag stands: off, dark, internal, N% or on. */
  stage?: string
  /** Its preview deploy (preview.ts): where, whether its check passed, and whether it has been taken down. */
  preview?: { url?: string; ok: boolean; at: number; sha?: string; check?: string; down?: boolean }
  /** The last metrics read for its flag, and the baseline from before the step. */
  metrics?: { at: number; stage: string; now: Record<string, number>; baseline?: Record<string, number> }
  /** Risky paths a person cleared when they made it everyday: only a new one makes it risky again. */
  cleared?: string[]
  /** One line on what happened last, for the status tool. */
  last?: string
}
