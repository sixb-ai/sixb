import type { AgentMessages } from "../i18n/en"
import type { NormalizedTool } from "../parts"

/** What a `message_agent` call reads as: which child the Agent told what, once it was sent. */
export function describeMessageAgent(tool: NormalizedTool, messages: AgentMessages): string {
  const input = isRecord(tool.input) ? tool.input : {}
  const key = typeof input.key === "string" ? input.key : ""
  const text = typeof input.text === "string" ? input.text : ""

  return tool.state === "output-available"
    ? messages.activity.toldAgent(key, text)
    : messages.activity.messagingAgent(key)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
