import { expect, test } from "bun:test"
import { channelVerdict, flagValues } from "../src/channels.ts"

const DEV = "--dangerously-load-development-channels"
const env = {} as NodeJS.ProcessEnv
const plugin = { CLAUDE_PLUGIN_ROOT: "/p" } as NodeJS.ProcessEnv

test("off without any channel flag", () => {
  expect(channelVerdict(["claude", "--debug"], env, null).on).toBe(false)
  expect(channelVerdict(["claude"], plugin, null).on).toBe(false)
})

test("off when the argv cannot be read", () => {
  expect(channelVerdict(null, env, null).on).toBe(false)
})

test("the development flag naming this server turns it on", () => {
  expect(channelVerdict(["claude", DEV, "server:crosstalk"], env, null).on).toBe(true)
  expect(channelVerdict(["claude", `${DEV}=server:crosstalk`], env, null).on).toBe(true)
  expect(channelVerdict(["claude", DEV, "plugin:crosstalk@inline", "--debug"], plugin, null).on).toBe(true)
  expect(channelVerdict(["claude", DEV, "server:other", "plugin:crosstalk@m"], plugin, null).on).toBe(true)
})

test("an entry for something else, or the wrong kind, is off", () => {
  expect(channelVerdict(["claude", DEV, "server:other"], env, null).on).toBe(false)
  expect(channelVerdict(["claude", DEV, "server:crosstalk"], plugin, null).on).toBe(false)
  expect(channelVerdict(["claude", DEV, "plugin:crosstalk@m"], env, null).on).toBe(false)
  expect(channelVerdict(["claude", DEV, "plugin:crosstalkx@m"], plugin, null).on).toBe(false)
})

test("--channels alone is off: crosstalk is not on the approved allowlist", () => {
  expect(channelVerdict(["claude", "--channels", "plugin:crosstalk@m"], plugin, null).on).toBe(false)
  const org = { channelsEnabled: true, allowedChannelPlugins: [{ plugin: "crosstalk", marketplace: "m" }] }
  expect(channelVerdict(["claude", "--channels", "plugin:crosstalk@m"], plugin, org).on).toBe(true)
})

test("vetoes: -p, the SDK, third-party providers, org policy", () => {
  const a = ["claude", DEV, "server:crosstalk"]
  expect(channelVerdict([...a, "-p", "hi"], env, null).on).toBe(false)
  expect(channelVerdict([...a, "--output-format", "stream-json"], env, null).on).toBe(false)
  expect(channelVerdict(a, { CLAUDE_CODE_ENTRYPOINT: "sdk-ts" } as any, null).on).toBe(false)
  expect(channelVerdict(a, { CLAUDE_CODE_USE_BEDROCK: "1" } as any, null).on).toBe(false)
  expect(channelVerdict(a, env, {}).on).toBe(false)
  expect(channelVerdict(a, env, { channelsEnabled: true }).on).toBe(true)
})

test("CROSSTALK_CHANNELS forces either way", () => {
  expect(channelVerdict(["claude"], { CROSSTALK_CHANNELS: "on" } as any, null).on).toBe(true)
  expect(channelVerdict(["claude", DEV, "server:crosstalk"], { CROSSTALK_CHANNELS: "off" } as any, null).on).toBe(false)
})

test("flagValues reads a variadic flag up to the next option", () => {
  expect(flagValues(["c", DEV, "a", "b", "--x", "c"], DEV)).toEqual(["a", "b"])
  expect(flagValues(["c", "--", DEV, "a"], DEV)).toEqual([])
})
