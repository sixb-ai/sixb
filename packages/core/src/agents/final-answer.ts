import type { AgentMessagePart } from "./message"

/**
 * The text written after the last local tool call of these steps: the answer the Agent gave, as a
 * child's parent reads it and as search indexes a turn. Text before a tool call it ran was the
 * Agent thinking aloud; a call its provider ran inline (a web search) does not end the answer.
 */
export function answerOfSteps(parts: readonly AgentMessagePart[]): string {
  const steps: AgentMessagePart[][] = []
  for (const part of parts) {
    if (part.type === "step-start" || steps.length === 0) steps.push([])
    if (part.type !== "step-start") steps.at(-1)?.push(part)
  }

  const ranTools = steps.map((step) =>
    step.some((part) => part.type === "tool-call" && part.providerExecuted !== true)
  )

  return steps
    .slice(ranTools.lastIndexOf(true) + 1)
    .flat()
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim()
}
