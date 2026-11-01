// The no-mods fallback: a classic UserPromptSubmit hook that blocks `%xt ...`.
const input = JSON.parse(await Bun.stdin.text())
if (String(input.prompt ?? "").startsWith("%xt ")) {
  console.log(JSON.stringify({ decision: "block", reason: "crosstalk fallback: answer recorded xt-reason CEDAR-2290" }))
}
