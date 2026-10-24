import type { AgentMessages } from "../i18n/en"
import type { NormalizedTool } from "../parts"

export interface MessageAgentDescription {
  /** The row's title: what the Agent told which child, or that it could not. */
  readonly title: string
  /** The live label while it is the latest work: short, in the moment. */
  readonly running: string
}

/** What a `message_agent` call reads as: while the Agent writes it, once sent, or refused. */
export function describeMessageAgent(
  tool: NormalizedTool,
  messages: AgentMessages
): MessageAgentDescription {
  const input = isRecord(tool.input) ? tool.input : {}
  const key = typeof input.key === "string" ? input.key.trim() : ""
  const text = typeof input.text === "string" ? input.text.trim() : ""
  const { activity } = messages

  if (!key) return { title: activity.messagingAgent, running: activity.messagingAgent }
  if (tool.state === "output-error") {
    const failed = activity.messageAgentFailed(key)
    return { title: failed, running: failed }
  }
  if (tool.state === "output-available") {
    return { title: activity.toldAgent(key, text), running: activity.toldAgentShort(key) }
  }
  const messaging = activity.messagingNamedAgent(key)
  return { title: messaging, running: messaging }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
