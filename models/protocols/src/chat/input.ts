import type { JsonObject, ModelMessage, ModelToolOutput } from "@sixb/core/models"
import { object } from "../json"

export interface ChatInputOptions {
  readonly providerId: string
  readonly errorPrefix: string
  readonly systemRole?: "system" | "developer"
  /** Preserve this provider's reasoning only within the latest user turn's tool continuation. */
  readonly reasoningReplay?: "omit" | "tool-continuation"
}

export function chatInput(
  messages: readonly ModelMessage[],
  options: ChatInputOptions
): JsonObject[] {
  const result: JsonObject[] = []
  let lastUser = -1
  for (let index = 0; index < messages.length; index++)
    if (messages[index]?.role === "user") lastUser = index
  for (const [index, message] of messages.entries()) {
    if (message.role === "system") {
      result.push({ role: options.systemRole ?? "system", content: message.content })
    } else if (message.role === "user") {
      result.push({
        role: "user",
        content: message.content.map((part): JsonObject => {
          if (part.type === "text") return { type: "text", text: part.text }
          if (!part.mediaType.startsWith("image/"))
            throw new TypeError(`${options.errorPrefix} Chat supports image file inputs only.`)
          return { type: "image_url", image_url: { url: part.data.href } }
        }),
      })
    } else if (message.role === "tool") {
      for (const part of message.content)
        result.push({ role: "tool", tool_call_id: part.toolCallId, content: output(part.output) })
    } else {
      const text: string[] = []
      const tools: JsonObject[] = []
      const reasoning: string[] = []
      for (const part of message.content) {
        if (part.type === "text") text.push(part.text)
        else if (part.type === "tool-call") {
          if (part.providerExecuted)
            throw new TypeError(
              `${options.errorPrefix} Chat does not support provider-executed tools.`
            )
          tools.push({
            id: part.toolCallId,
            type: "function",
            function: { name: part.toolName, arguments: JSON.stringify(part.input) },
          })
        } else if (part.type === "reasoning") {
          const raw = object(part.providerData?.[options.providerId])?.reasoning_content
          if (typeof raw === "string") reasoning.push(raw)
        } else if (part.type === "provider-state" && part.providerId === options.providerId) {
          throw new TypeError(
            `${options.errorPrefix} Chat cannot replay opaque provider-state blocks.`
          )
        } else if (part.type === "tool-result")
          throw new TypeError(`${options.errorPrefix} Chat tool results must have the tool role.`)
      }
      if (!text.length && !tools.length) continue
      result.push({
        role: "assistant",
        content: text.length ? text.join("") : null,
        ...(tools.length ? { tool_calls: tools } : {}),
        ...(options.reasoningReplay === "tool-continuation" &&
        index > lastUser &&
        tools.length &&
        reasoning.length
          ? { reasoning_content: reasoning.join("") }
          : {}),
      })
    }
  }
  return result
}

function output(value: ModelToolOutput): string {
  return value.type === "text" || value.type === "error-text"
    ? value.value
    : JSON.stringify(value.value)
}
