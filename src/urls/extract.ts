// URLs out of what a command printed, and what each one is (docs/urls.md).
// Pure: nothing here fetches, follows or opens a link.
//
//   only http(s)        anything else is not a URL a person reviews
//   local               localhost, 127.0.0.1, ::1, 0.0.0.0, *.localhost; 0.0.0.0
//                       and :: become localhost, which a browser can open
//   pr                  a GitHub pull request (github.com/<o>/<r>/pull/<n>)
//   link                anything else
//   noise               package registries, docs, schemas, funding pages:
//                       what installs and builds print on every run
//   secrets             query parameters named like a token (token, key, secret,
//                       sig, auth, code, password, credential, session…) or
//                       whose value looks like one are taken out, and so are a
//                       user and password before the host and a fragment with
//                       parameters in it (an OAuth token)
//   capped              at most MAX_PER_CALL from one output

import type { UrlKind } from "./store.ts"

export const MAX_PER_CALL = 10
export const MAX_URL = 400

export type Found = { url: string; kind: UrlKind; host: string; port?: number; path: string }

/** ANSI and OSC sequences out, so a coloured URL is one URL. */
export const stripAnsi = (s: string) => s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-_]/g, "")

const LOCAL = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0|\[::\]|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.localhost)$/i
export const isLocalHost = (host: string) => LOCAL.test(host)

/** Hosts whose links are what tools print on every run, not what anyone is building. */
const NOISE_HOSTS = [
  "registry.npmjs.org",
  "docs.npmjs.com",
  "npmjs.com",
  "www.npmjs.com",
  "npm.community",
  "registry.yarnpkg.com",
  "yarnpkg.com",
  "classic.yarnpkg.com",
  "pnpm.io",
  "opencollective.com",
  "nodejs.org",
  "bun.sh",
  "deno.land",
  "pypi.org",
  "files.pythonhosted.org",
  "pip.pypa.io",
  "crates.io",
  "static.crates.io",
  "index.crates.io",
  "docs.rs",
  "go.dev",
  "pkg.go.dev",
  "proxy.golang.org",
  "rubygems.org",
  "json-schema.org",
  "www.w3.org",
  "w3.org",
  "schemas.xmlsoap.org",
  "example.com",
  "example.org",
  "example.net",
  "git-scm.com",
  "aka.ms",
  "docs.github.com",
  "help.github.com",
  "cli.github.com",
  "githubusercontent.com",
  "brew.sh",
  "formulae.brew.sh",
  "hub.docker.com",
  "registry-1.docker.io",
  "docs.docker.com",
  "nextjs.org",
  "vitejs.dev",
  "vite.dev",
  "react.dev",
  "reactjs.org",
  "typescriptlang.org",
  "www.typescriptlang.org",
  "eslint.org",
  "prettier.io",
  "webpack.js.org",
  "babeljs.io",
  "jestjs.io",
  "vitest.dev",
  "playwright.dev",
  "developer.mozilla.org",
  "stackoverflow.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "cdn.jsdelivr.net",
  "unpkg.com",
]
const NOISE_PATHS = [/^github\.com\/(sponsors|advisories)\b/, /^github\.com\/[^/]+\/[^/]+\/(issues|discussions)\/new\b/, /^github\.com\/settings\b/, /^nextjs\.org\/telemetry/]

export function isNoise(u: URL): boolean {
  const h = u.hostname.toLowerCase()
  if (NOISE_HOSTS.some((n) => h === n || h.endsWith(`.${n}`))) return true
  const hp = `${h}${u.pathname}`
  return NOISE_PATHS.some((r) => r.test(hp))
}

/** A parameter's name that says it is a credential. */
export const SECRET_PARAM = /(token|key|secret|sig|auth|code|pass(word|wd)?|pwd|credential|session|jwt|bearer|otp|nonce|ticket)/i
/** A value that looks like a credential whatever its name: a JWT, a vendor token, a long random string. */
export const SECRET_VALUE = /^(eyJ[\w-]{8,}|gh[pousr]_\w{10,}|github_pat_\w+|sk-[\w-]{10,}|xox[abprs]-[\w-]+|AKIA[0-9A-Z]{12,}|[A-Za-z0-9+/_=-]{32,})$/

/** The URL with every credential-looking part taken out. */
export function stripSecrets(u: URL): URL {
  const out = new URL(u.href)
  out.username = ""
  out.password = ""
  for (const [k, v] of [...out.searchParams]) if (SECRET_PARAM.test(k) || SECRET_VALUE.test(v)) out.searchParams.delete(k)
  // An OAuth implicit grant puts the token in the fragment; a plain anchor has no '='.
  if (out.hash.includes("=") || SECRET_VALUE.test(out.hash.slice(1))) out.hash = ""
  // `?` with nothing left after it.
  if (![...out.searchParams].length) out.search = ""
  return out
}

export function kindOf(u: URL): UrlKind {
  if (isLocalHost(u.hostname)) return "local"
  if (/^(www\.)?github\.com$/i.test(u.hostname) && /^\/[^/]+\/[^/]+\/pull\/\d+/.test(u.pathname)) return "pr"
  return "link"
}

/** A PR's number from its URL. */
export const prNumber = (url: string) => /\/pull\/(\d+)/.exec(url)?.[1]

const RE = /https?:\/\/[^\s"'<>`\\{}|^]+/gi

/** The URLs a command printed: http(s), not noise, credentials taken out, local hosts made openable, at most `max`. */
export function extractUrls(text: string, o: { max?: number } = {}): Found[] {
  const max = o.max ?? MAX_PER_CALL
  const out: Found[] = []
  const seen = new Set<string>()
  const clean = stripAnsi(text)
  for (const m of clean.matchAll(RE)) {
    if (out.length >= max) break
    // Sentence punctuation and a closing bracket the URL did not open.
    let raw = m[0].replace(/[.,;:!?]+$/, "")
    for (const [open, close] of [["(", ")"], ["[", "]"]] as const) while (raw.endsWith(close) && raw.split(open).length < raw.split(close).length) raw = raw.slice(0, -1).replace(/[.,;:!?]+$/, "")
    if (raw.length > 2000) continue
    let u: URL
    try {
      u = new URL(raw)
    } catch {
      continue
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue
    if (!u.hostname || (!isLocalHost(u.hostname) && !u.hostname.includes("."))) continue
    if (isNoise(u)) continue
    u = stripSecrets(u)
    if (u.hostname === "0.0.0.0" || u.hostname === "[::]") u.hostname = "localhost"
    const url = u.href.length > MAX_URL ? null : u.href
    if (!url || seen.has(url)) continue
    seen.add(url)
    out.push({ url, kind: kindOf(u), host: u.hostname.toLowerCase(), ...(u.port ? { port: Number(u.port) } : {}), path: u.pathname })
  }
  return out
}

// --- labels ---------------------------------------------------------------------------

/** What a service is called in a label: `npm run dev` is the dev server. */
export const serviceWhat = (name: string) => (/^(dev|serve|server|start)$/.test(name) ? "dev server" : name)

const prefix = (group: string | undefined, what: string) => (group ? `${group} · ${what}` : what)

/** `auth · dev server`, `auth · preview`, `auth · PR #12`, `auth · :5173`, `auth · github.com/o/r`. */
export function labelFor(o: { kind: UrlKind; group?: string; service?: string; feature?: string; url: string }): string {
  if (o.service) return prefix(o.group, serviceWhat(o.service))
  if (o.kind === "preview") return prefix(o.group, o.feature && o.feature !== o.group ? `preview (${o.feature})` : "preview")
  if (o.kind === "pr") {
    const n = prNumber(o.url)
    return prefix(o.group, n ? `PR #${n}` : "PR")
  }
  let u: URL
  try {
    u = new URL(o.url)
  } catch {
    return prefix(o.group, o.url.slice(0, 60))
  }
  const p = u.pathname === "/" ? "" : u.pathname.length > 32 ? `${u.pathname.slice(0, 31)}…` : u.pathname
  if (o.kind === "local") return prefix(o.group, `${u.hostname === "localhost" || /^127\./.test(u.hostname) || u.hostname === "[::1]" ? "" : u.hostname}${u.port ? `:${u.port}` : ""}${p}` || u.hostname)
  return prefix(o.group, `${u.hostname.replace(/^www\./, "")}${p}`)
}
