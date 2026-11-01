import { expect, test } from "bun:test"
import type { ModelMessage } from "@sixb/core/models"
import { gatewayPromptCaching } from "../src/provider-caching"

const system: ModelMessage = { role: "system", content: "You are the project's agent." }
const user: ModelMessage = { role: "user", content: [{ type: "text", text: "Hello" }] }
const answer: ModelMessage = { role: "assistant", content: [{ type: "text", text: "Hi." }] }

function caching(overrides: Partial<Parameters<typeof gatewayPromptCaching>[0]> = {}) {
  return gatewayPromptCaching({
    modelId: "anthropic/claude-opus-5.5",
    providerOptions: undefined,
    request: {},
    caching: undefined,
    messages: [system, user],
    localTools: 1,
    ...overrides,
  })
}

test("caches agent steps and anchors the system prompt as top-level Gateway fields", () => {
  // Regression proof: send caching in providerOptions.gateway, where Gateway ignores the anchor.
  expect(caching()).toEqual({
    body: { caching: "auto", cache_anchor_items: 1 },
    providerOptions: undefined,
    headers: {},
  })
  expect(caching({ localTools: 0, messages: [system, system, user, answer, user] }).body).toEqual({
    caching: "auto",
    cache_anchor_items: 2,
  })
  expect(caching({ messages: [user] }).body).toEqual({ caching: "auto" })
})

test("keeps project options beside automatic caching", () => {
  const providerOptions = { gateway: { zeroDataRetention: true, order: ["anthropic"] } }
  expect(caching({ providerOptions }).providerOptions).toBe(providerOptions)
})

test.each([
  ["Anthropic", "anthropic/claude-opus-5.5", undefined],
  ["OpenAI before GPT-5.6", "openai/gpt-5.5", undefined],
  [
    "OpenAI GPT-5.6",
    "openai/gpt-5.6-sol",
    { openai: { promptCacheOptions: { mode: "explicit" } } },
  ],
  [
    "OpenAI GPT-6.1",
    "openai/gpt-6.1-sol-fast",
    { openai: { promptCacheOptions: { mode: "explicit" } } },
  ],
] as const)("writes no cache for a one-shot request on %s", (_name, modelId, providerOptions) => {
  // Regression proof: cache every request; compaction summaries and generate() pay 1.25x input.
  expect(caching({ modelId, localTools: 0 })).toEqual({ body: {}, providerOptions, headers: {} })
})

test("follows the request's caching choice", () => {
  expect(caching({ localTools: 0, caching: "auto" }).body).toEqual({
    caching: "auto",
    cache_anchor_items: 1,
  })
  expect(caching({ caching: "off" })).toEqual({
    body: {},
    providerOptions: undefined,
    headers: {},
  })
  expect(caching({ modelId: "openai/gpt-6-astra", caching: "off" }).providerOptions).toEqual({
    openai: { promptCacheOptions: { mode: "explicit" } },
  })
})

test.each([
  ["a project caching setting", { gateway: { caching: null } }, {}],
  ["a caching request field", undefined, { caching: "auto" }],
  ["a project OpenAI cache setting", { openai: { promptCacheOptions: { mode: "implicit" } } }, {}],
] as const)("leaves %s to the project", (_name, providerOptions, request) => {
  const result = caching({
    modelId: "openai/gpt-6.1-sol",
    providerOptions,
    request,
    localTools: 0,
  })
  expect(result).toEqual({ body: {}, providerOptions, headers: {} })
})

test("asks for the hour-long cache only for a long-lived prompt it caches", () => {
  // Regression proof: drop `cache_ttl` from gatewayPromptCaching; a reply after 5 minutes rewrites
  // the whole conversation.
  expect(caching({ caching: { lifetime: "long" } }).body).toEqual({
    caching: "auto",
    cache_anchor_items: 1,
    cache_ttl: "1h",
  })
  expect(caching({ caching: { lifetime: "default" } }).body).toEqual({
    caching: "auto",
    cache_anchor_items: 1,
  })

  // An intent caches what an absent choice would: a one-shot request still writes nothing.
  expect(caching({ caching: { lifetime: "long" }, localTools: 0 })).toEqual(
    caching({ localTools: 0 })
  )
})

test.each([
  ["its own TTL", undefined, { cache_ttl: "5m" }, { caching: "auto", cache_anchor_items: 1 }],
  ["its caching request field", undefined, { caching: "auto" }, {}],
  ["its Gateway caching option", { gateway: { caching: "off" } }, {}, {}],
] as const)("leaves the cache lifetime to a project that sets %s", (_name, providerOptions, request, body) => {
  expect(caching({ caching: { lifetime: "long" }, providerOptions, request }).body).toEqual(body)
})

test("names the conversation in the session affinity header, unless the project does", () => {
  // Regression proof: return no headers from gatewayPromptCaching; a conversation's steps spread
  // over upstreams that do not hold its cache.
  const key = "sixb_9f2c1e"
  expect(caching({ caching: { key } }).headers).toEqual({ "x-session-affinity": key })
  expect(caching({ caching: { key }, localTools: 0 }).headers).toEqual({
    "x-session-affinity": key,
  })
  expect(caching({ caching: { key }, headers: { "X-Session-Affinity": "mine" } }).headers).toEqual(
    {}
  )
  expect(caching({ caching: "auto" }).headers).toEqual({})
})
