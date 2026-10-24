import type { AgentMessages } from "../i18n/en"
import { type NormalizedTool, toolResultValue } from "../parts"

export interface MessageAgentDescription {
  /** The row's title: what the Agent told which child, or that it could not. */
  readonly title: string
  /** The live label while it is the latest work: short, in the moment. */
  readonly running: string
}

/** A question a child waits on, as `wait_agent` returned it. */
export interface ChildQuestion {
  readonly key: string
  readonly text: string
}

/**
 * What a `message_agent` call reads as: while the Agent writes it, once sent, or refused. Sent to
 * a child waiting on its question, it is the Agent's answer.
 */
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
    const output = toolResultValue(tool.output)
    return isRecord(output) && output.delivery === "answer"
      ? { title: activity.answeredAgent(key, text), running: activity.answeredAgentShort(key) }
      : { title: activity.toldAgent(key, text), running: activity.toldAgentShort(key) }
  }
  const messaging = activity.messagingNamedAgent(key)
  return { title: messaging, running: messaging }
}

/** The questions a `wait_agent` call returned: the children that wait on the Agent's answer. */
export function childQuestions(tool: NormalizedTool): readonly ChildQuestion[] {
  if (tool.toolName !== "wait_agent" || tool.state !== "output-available") return []

  const output = toolResultValue(tool.output)
  if (!isRecord(output) || !Array.isArray(output.questions)) return []
  return output.questions.flatMap((question: unknown) =>
    isRecord(question) && typeof question.key === "string" && typeof question.text === "string"
      ? [{ key: question.key, text: question.text }]
      : []
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
