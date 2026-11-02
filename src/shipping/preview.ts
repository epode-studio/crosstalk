// Preview per thread: a risky feature's branch, deployed somewhere of its own
// before it merges, with its flag forced on, and checked there.
//
//   preview: vercel deploy --prebuilt          # or fly deploy --app x-pr-{branch}, or any script
//   preview_check: npx playwright test         # gets PREVIEW_URL
//   preview_teardown: vercel rm {url} --yes    # once merged
//
// Each runs in a detached copy of the branch (dependencies linked from the
// main checkout) with:
//
//   CROSSTALK_FLAGS     "<flag>=on", the feature's flag forced on
//   CROSSTALK_BRANCH    the branch; {branch} in the command is it, made safe for a hostname
//   CROSSTALK_FEATURE   the feature's name
//   PREVIEW_URL         (check and teardown) the URL the preview printed; {url} too
//
// The URL is the last http(s) URL the preview printed, or a line
// `PREVIEW_URL=<url>` when there is one. What the check said becomes evidence.

import path from "node:path"
import * as G from "./git.ts"

export type PreviewResult = {
  ok: boolean
  url?: string
  /** The deploy's last lines. */
  out: string
  check?: { ok: boolean; cmd: string; out: string }
  error?: string
}

/** The URL out of what a preview printed. */
export function previewUrl(out: string): string | undefined {
  const explicit = [...out.matchAll(/^\s*PREVIEW_URL\s*=\s*(\S+)\s*$/gm)].pop()?.[1]
  if (explicit) return explicit
  const urls = [...out.matchAll(/https?:\/\/[^\s"'<>`)\]]+/g)].map((m) => m[0].replace(/[.,;:]+$/, ""))
  return urls.pop()
}

/** A branch name as it can sit in a hostname: crosstalk/login-v2 → crosstalk-login-v2. */
export const branchSlug = (b: string) =>
  b
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "") || "branch"

export const fill = (cmd: string, v: { branch: string; url?: string; flag?: string }) =>
  cmd
    .replace(/\{branch\}/g, branchSlug(v.branch))
    .replace(/\{url\}/g, v.url ?? "")
    .replace(/\{flag\}/g, v.flag ?? "")

const tail = (s: string, n = 30) => s.trim().split("\n").slice(-n).join("\n")

export type PreviewInput = {
  root: string
  branch: string
  flag?: string
  feature: string
  scratchDir: string
  deploy: string
  check?: string
  timeoutS: number
}

export function previewEnv(i: { branch: string; flag?: string; feature: string; url?: string }): Record<string, string> {
  return {
    CROSSTALK_FLAGS: i.flag ? `${i.flag}=on` : "",
    CROSSTALK_BRANCH: i.branch,
    CROSSTALK_FEATURE: i.feature,
    ...(i.url ? { PREVIEW_URL: i.url } : {}),
  }
}

/** Deploy the branch's preview and, when there is a check, run it against the URL. */
export async function runPreview(i: PreviewInput): Promise<PreviewResult> {
  const sha = G.tip(i.root, `refs/heads/${i.branch}`)
  if (!sha) return { ok: false, out: "", error: `no branch ${i.branch}` }
  const where = path.join(i.scratchDir, `preview-${branchSlug(i.branch)}-${Date.now().toString(36)}`)
  const s = G.scratch(i.root, sha, where)
  if (!s.ok) return { ok: false, out: "", error: `no copy to deploy from: ${s.err}` }
  try {
    G.linkDeps(G.mainOf(i.root) ?? i.root, where)
    const env = previewEnv(i)
    const d = await G.sh(fill(i.deploy, { branch: i.branch, flag: i.flag }), where, i.timeoutS * 1000, env)
    const url = previewUrl(d.out)
    if (!d.ok) return { ok: false, url, out: tail(d.out), error: `the preview command failed (${d.code ?? "timed out"})` }
    if (!url) return { ok: false, out: tail(d.out), error: "the preview printed no URL (print it, or a line PREVIEW_URL=<url>)" }
    if (!i.check) return { ok: true, url, out: tail(d.out) }
    const cmd = fill(i.check, { branch: i.branch, url, flag: i.flag })
    const c = await G.sh(cmd, where, i.timeoutS * 1000, { ...env, PREVIEW_URL: url, CI: "1" })
    return { ok: c.ok, url, out: tail(d.out, 10), check: { ok: c.ok, cmd: i.check, out: tail(c.out) }, ...(c.ok ? {} : { error: "the preview check failed" }) }
  } finally {
    G.dropScratch(i.root, where)
  }
}

/** Take a preview down once its branch has merged. Runs in the main checkout. */
export async function teardown(o: { root: string; cmd: string; branch: string; url?: string; flag?: string; feature: string; timeoutS: number }) {
  const main = G.mainOf(o.root) ?? o.root
  const r = await G.sh(fill(o.cmd, o), main, o.timeoutS * 1000, previewEnv(o))
  return { ok: r.ok, out: tail(r.out, 10) }
}
