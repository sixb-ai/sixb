import type { JsonObject, ModelCaching } from "@sixb/core/models"
import { object, string } from "../json"

/**
 * Claude caches only what a request marks, so Sixb marks the prefixes it repeats, for the
 * Anthropic API and for Claude on Azure AI Foundry alike:
 *
 * - the last local tool: tools render first and match across a project's threads and users;
 * - the last system block: the system prompt holds for a thread across turns, even when replayed
 *   history differs;
 * - the conversation tail, through automatic caching: agent steps only append, so each step reads
 *   what the previous one wrote.
 *
 * A one-shot request (no tools and no earlier answer) is left alone unless it asks for `"auto"`:
 * nothing reads its prefix again, so a cache write would only add 25% to its input price.
 * `caching: "off"` adds nothing. Every breakpoint shares one TTL, since longer TTLs must come
 * first: the request's own `cache_control`, else an hour for a prompt read again after a
 * human pause (an intent's `"long"` lifetime), else Anthropic's five minutes.
 */
export function messagesPromptCaching(
  body: JsonObject,
  caching: ModelCaching | undefined,
  localTools: number
): JsonObject {
  if (caching === "off") return body
  const messages = Array.isArray(body.messages) ? body.messages : []
  const continues = messages.some((message) => object(message)?.role === "assistant")
  if (caching !== "auto" && localTools === 0 && !continues) return body

  const long = typeof caching === "object" && caching.lifetime === "long"
  const marker = object(body.cache_control) ?? {
    type: "ephemeral",
    ...(long ? { ttl: "1h" } : {}),
  }
  const tools = Array.isArray(body.tools) ? body.tools : []
  const system = Array.isArray(body.system) ? body.system : []
  const lastSystem = object(system.at(-1))
  const markSystem = lastSystem?.type === "text" && string(lastSystem.text) !== ""

  return {
    ...body,
    cache_control: marker,
    ...(localTools === 0
      ? {}
      : { tools: [...tools.slice(0, -1), { ...object(tools.at(-1)), cache_control: marker }] }),
    ...(markSystem
      ? { system: [...system.slice(0, -1), { ...lastSystem, cache_control: marker }] }
      : {}),
  }
}
