import { type AgentContextInput, agentContextIdentity } from "@sixb/core/agents/context"

export function agentContextLabel(context: AgentContextInput): string {
  return context.kind === "object"
    ? `${context.ref.objectTypeId} ${context.ref.primaryId}`
    : context.label
}

export function mergeAgentContext(
  primary: readonly AgentContextInput[],
  secondary: readonly AgentContextInput[]
): readonly AgentContextInput[] {
  const values = new Map(primary.map((context) => [agentContextIdentity(context), context]))
  for (const context of secondary) {
    const identity = agentContextIdentity(context)
    if (!values.has(identity)) values.set(identity, context)
  }
  return [...values.values()]
}
