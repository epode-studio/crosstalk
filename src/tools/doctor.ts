// crosstalk_doctor: what is wrong and how to fix it, how crosstalk is doing,
// and what you can say to it.

import { bool, def, num, only, type Tool } from "./kit.ts"

const ACTIONS = ["report", "stats", "intro", "open_items", "auto_merge", "merge_queue"] as const

const description = `What is wrong with crosstalk and how to fix it. Actions: report (identity, daemon, relay, this session's inbox, sessions to restore, macOS permissions, each with its fix: show it, then help with whatever is marked ✗; for "is crosstalk OK?", "why aren't messages arriving?"); stats (local measurements, never sent anywhere; relay the text); intro ("what can crosstalk do?", "how do I use this?": things to say, to show as they are); open_items, auto_merge, merge_queue (on: false stops tackling Open lists, merging green PRs, or unblocking merge queues by itself; true starts).`

export const doctor: Tool = {
  actions: ACTIONS,
  def: def("crosstalk_doctor", description, ACTIONS, { weeks: num("stats: how many weeks back, default 4"), on: bool("true or false") }),
  route: (a) => {
    switch (a.action) {
      case "report":
        return { name: "crosstalk_doctor", args: {} }
      case "stats":
        return { name: "crosstalk_stats", args: only(a, "weeks") }
      case "intro":
        return { name: "crosstalk_intro", args: {} }
      case "open_items":
        return { name: "crosstalk_open_items", args: only(a, "on") }
      case "auto_merge":
        return { name: "crosstalk_auto_merge", args: only(a, "on") }
      case "merge_queue":
        return { name: "crosstalk_merge_queue", args: only(a, "on") }
    }
    return { error: `crosstalk_doctor has no action "${a.action}"` }
  },
}
