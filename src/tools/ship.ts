// crosstalk_ship: getting a thread's features out. Declare one and its risk,
// say it is ready, hand in a review, attach evidence, move a flag, report an
// incident, see where they stand. The daemon's engine (src/shipping/) decides.

import { def, oneOf, only, str, strs, type Tool } from "./kit.ts"

const ACTIONS = ["feature", "ready", "review", "evidence", "flag", "incident", "status"] as const

const description = `Ship a thread's features. Actions: feature (declare one by name when distinct work starts; risk "risky" with why when it could hurt users, data, money or security, and keep its new behaviour behind the flag; you can never make it everyday yourself); ready (committed on its branch: fresh reviewers run, then checks and the merge; after findings, fix, commit and call again with response; never merge or push yourself); review (only for a reviewer crosstalk started: verdict approve|changes with findings); evidence (behaviour in plain words with proof, never a diff: tests, evals, before_after, screenshots; risky features need it, per flag stage too); flag (stage off works at once, on any regression; turning a risky one up is a person's question); incident (something wrong in production; link ties an incident thread to its cause); status.`

export const ship: Tool = {
  actions: ACTIONS,
  def: def("crosstalk_ship", description, ACTIONS, {
    name: str('feature: a few plain words, e.g. "login with passkeys"'),
    feature: str("ready, evidence, flag: the feature's name"),
    thread: str("Which thread; default this session's"),
    risk: oneOf(["everyday", "risky"], "feature"),
    why: str("feature, flag"),
    flag: str("feature, flag, incident"),
    branch: str("feature: default this session's"),
    response: str("ready, after a review: what you changed and what you disagree with, and why"),
    run: str("review"),
    verdict: oneOf(["approve", "changes"], "review"),
    findings: str("review"),
    summary: str("evidence: what changed in behaviour"),
    tests: strs("evidence"),
    evals: strs("evidence"),
    before_after: { type: "array", description: "evidence", items: { type: "object", properties: { before: str(), after: str() }, required: ["before", "after"] } },
    screenshots: strs("evidence: paths or URLs"),
    stage: str("flag: off, dark, internal, N% or on; evidence: the stage it was gathered at"),
    source: str("incident: sentry, pagerduty, a user…"),
    title: str("incident"),
    details: str("incident"),
    files: strs("incident"),
    sha: str("incident: the deployed commit"),
    link: { type: "object", description: "incident: tie an incident thread to its cause", properties: { incident: str(), cause: str() }, required: ["incident", "cause"] },
  }),
  route: (a) => {
    switch (a.action) {
      case "feature":
        return { name: "crosstalk_feature", args: only(a, "name", "thread", "risk", "why", "flag", "branch") }
      case "ready":
        return { name: "crosstalk_ready", args: only(a, "feature", "thread", "response") }
      case "review":
        return { name: "crosstalk_review", args: only(a, "run", "verdict", "findings") }
      case "evidence":
        return { name: "crosstalk_evidence", args: only(a, "feature", "thread", "summary", "tests", "evals", "before_after", "screenshots", "stage") }
      case "flag":
        return { name: "crosstalk_flag", args: only(a, "flag", "feature", "thread", "stage", "why") }
      case "incident":
        return { name: "crosstalk_incident", args: only(a, "source", "title", "details", "flag", "files", "sha", "link") }
      case "status":
        return { name: "crosstalk_ship_status", args: only(a, "thread") }
    }
    return { error: `crosstalk_ship has no action "${a.action}"` }
  },
}
