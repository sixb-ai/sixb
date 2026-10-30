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
  expect(caching({ modelId, localTools: 0 })).toEqual({ body: {}, providerOptions })
})

test("follows the request's caching choice", () => {
  expect(caching({ localTools: 0, caching: "auto" }).body).toEqual({
    caching: "auto",
    cache_anchor_items: 1,
  })
  expect(caching({ caching: "off" })).toEqual({ body: {}, providerOptions: undefined })
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
  expect(result).toEqual({ body: {}, providerOptions })
})
