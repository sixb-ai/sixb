import {
  isJsonObject,
  type JsonObject,
  type ModelCaching,
  type ModelMessage,
} from "@sixb/core/models"

// OpenAI GPT-5.6 and later take `prompt_cache_options`; earlier models reject it with a 400.
const OPENAI_CACHE_OPTIONS =
  /^openai\/gpt-(?:5\.(?:[6-9]|\d{2,})|(?:[6-9]|\d{2,})(?:\.\d+)?)(?:-|$)/

/** Keeps a conversation on the upstream provider that holds its cache. */
export const SESSION_AFFINITY_HEADER = "x-session-affinity"

export interface GatewayPromptCaching {
  /** Top-level Responses fields: automatic caching, its anchor and its lifetime. */
  readonly body: JsonObject
  readonly providerOptions: JsonObject | undefined
  /** The session affinity header, when the request names its conversation. */
  readonly headers: Readonly<Record<string, string>>
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
 * - An intent caches what an absent choice would. Its `"long"` lifetime asks for the hour-long
 *   cache (`cache_ttl: "1h"`, a warning and never an error where the model has none), and its key
 *   becomes the session affinity header, which keeps a conversation on the upstream that holds its
 *   cache. A project's own TTL or affinity header wins.
 */
export function gatewayPromptCaching(input: {
  readonly modelId: string
  readonly providerOptions: JsonObject | undefined
  readonly request: JsonObject
  readonly caching: ModelCaching | undefined
  readonly messages: readonly ModelMessage[]
  readonly localTools: number
  /** The binding's own headers: an affinity header there wins. */
  readonly headers?: Readonly<Record<string, string>>
}): GatewayPromptCaching {
  const { providerOptions } = input
  const headers = affinityHeaders(input.caching, input.headers)
  const gateway = providerOptions?.gateway
  if (gateway !== undefined && !isJsonObject(gateway)) return { body: {}, providerOptions, headers }
  if (
    (gateway !== undefined && Object.hasOwn(gateway, "caching")) ||
    Object.hasOwn(input.request, "caching")
  ) {
    return { body: {}, providerOptions, headers }
  }

  const reusable =
    input.caching === "auto" ||
    (input.caching !== "off" &&
      (input.localTools > 0 || input.messages.some((message) => message.role === "assistant")))
  if (reusable) {
    const leadingSystem = input.messages.findIndex((message) => message.role !== "system")
    const anchor = leadingSystem === -1 ? input.messages.length : leadingSystem
    const long =
      typeof input.caching === "object" &&
      input.caching.lifetime === "long" &&
      !Object.hasOwn(input.request, "cache_ttl")

    return {
      body: {
        caching: "auto",
        ...(anchor === 0 ? {} : { cache_anchor_items: anchor }),
        ...(long ? { cache_ttl: "1h" } : {}),
      },
      providerOptions,
      headers,
    }
  }

  const openai = providerOptions?.openai
  if (
    !OPENAI_CACHE_OPTIONS.test(input.modelId) ||
    (openai !== undefined && !isJsonObject(openai)) ||
    (isJsonObject(openai) && Object.hasOwn(openai, "promptCacheOptions"))
  ) {
    return { body: {}, providerOptions, headers }
  }
  // Explicit mode without breakpoints: the request neither writes nor reads a cache entry.
  return {
    body: {},
    providerOptions: {
      ...providerOptions,
      openai: { ...openai, promptCacheOptions: { mode: "explicit" } },
    },
    headers,
  }
}

function affinityHeaders(
  caching: ModelCaching | undefined,
  configured: Readonly<Record<string, string>> | undefined
): Readonly<Record<string, string>> {
  if (typeof caching !== "object" || !caching.key) return {}

  const own = Object.keys(configured ?? {}).some(
    (name) => name.toLowerCase() === SESSION_AFFINITY_HEADER
  )
  return own ? {} : { [SESSION_AFFINITY_HEADER]: caching.key }
}
