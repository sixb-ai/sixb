import { isJsonObject, type JsonObject, type ModelMessage } from "@sixb/core/models"

// OpenAI GPT-5.6 and later take `prompt_cache_options`; earlier models reject it with a 400.
const OPENAI_CACHE_OPTIONS =
  /^openai\/gpt-(?:5\.(?:[6-9]|\d{2,})|(?:[6-9]|\d{2,})(?:\.\d+)?)(?:-|$)/

export interface GatewayPromptCaching {
  /** Top-level Responses fields: automatic caching and its anchor. */
  readonly body: JsonObject
  readonly providerOptions: JsonObject | undefined
}

/**
 * Cache what a request will reuse, and nothing else, without leaking provider policy into project
 * Agent definitions. Explicit project configuration always wins.
 *
 * - A request with tools or an earlier answer (agent steps, chat turns) gets Gateway automatic
 *   caching. Explicit-caching providers such as Anthropic then cache the conversation tail, and
 *   `cache_anchor_items` also marks the leading system messages, which hold across turns even
 *   when replayed history differs. Gateway reads both only as top-level fields.
 * - A one-shot request (compaction summaries, `generate()`) is read once, so a cache write would
 *   only add 25% to its input price. It gets no automatic caching, and OpenAI GPT-5.6 and later,
 *   which cache implicitly, are told to write nothing.
 * - `caching: "off"` caches nothing; `"auto"` caches a one-shot request too.
 */
export function gatewayPromptCaching(input: {
  readonly modelId: string
  readonly providerOptions: JsonObject | undefined
  readonly request: JsonObject
  readonly caching: "auto" | "off" | undefined
  readonly messages: readonly ModelMessage[]
  readonly localTools: number
}): GatewayPromptCaching {
  const { providerOptions } = input
  const gateway = providerOptions?.gateway
  if (gateway !== undefined && !isJsonObject(gateway)) return { body: {}, providerOptions }
  if (
    (gateway !== undefined && Object.hasOwn(gateway, "caching")) ||
    Object.hasOwn(input.request, "caching")
  ) {
    return { body: {}, providerOptions }
  }

  const reusable =
    input.caching === "auto" ||
    (input.caching !== "off" &&
      (input.localTools > 0 || input.messages.some((message) => message.role === "assistant")))
  if (reusable) {
    const leadingSystem = input.messages.findIndex((message) => message.role !== "system")
    const anchor = leadingSystem === -1 ? input.messages.length : leadingSystem
    return {
      body: { caching: "auto", ...(anchor === 0 ? {} : { cache_anchor_items: anchor }) },
      providerOptions,
    }
  }

  const openai = providerOptions?.openai
  if (
    !OPENAI_CACHE_OPTIONS.test(input.modelId) ||
    (openai !== undefined && !isJsonObject(openai)) ||
    (isJsonObject(openai) && Object.hasOwn(openai, "promptCacheOptions"))
  ) {
    return { body: {}, providerOptions }
  }
  // Explicit mode without breakpoints: the request neither writes nor reads a cache entry.
  return {
    body: {},
    providerOptions: {
      ...providerOptions,
      openai: { ...openai, promptCacheOptions: { mode: "explicit" } },
    },
  }
}
