// crosstalk_doctor: what is wrong and how to fix it, and how crosstalk is doing.

import { def, num, only, type Tool } from "./kit.ts"

const ACTIONS = ["report", "stats"] as const

const description = `What is wrong with crosstalk and how to fix it. Actions: report (identity, daemon, relay, this session's inbox, sessions to restore, macOS permissions, each with its fix: show it, then help with whatever is marked ✗; for "is crosstalk OK?", "why aren't messages arriving?"); stats (local measurements, never sent anywhere: time to merge, human minutes, questions answered by rules, tokens to first edit; relay the text).`

export const doctor: Tool = {
  actions: ACTIONS,
  def: def("crosstalk_doctor", description, ACTIONS, { weeks: num("stats: how many weeks back, default 4") }),
  route: (a) => {
    switch (a.action) {
      case "report":
        return { name: "crosstalk_doctor", args: {} }
      case "stats":
        return { name: "crosstalk_stats", args: only(a, "weeks") }
    }
    return { error: `crosstalk_doctor has no action "${a.action}"` }
  },
}
