import type {
  AgentDefinition,
  AgentReasoningLevel,
  AgentToolDefinition,
  LanguageModelCatalog,
} from "@sixb/core"
import { createSixbError } from "@sixb/core/internal/errors"

/**
 * Fully resolved inputs shared by the agent execution engines.
 *
 * This internal runtime value is neither a durable run nor a public API contract. Source-specific
 * adapters resolve it before entering the shared execution path.
 */
export interface ResolvedAgentExecutionPlan {
  readonly model: AgentDefinition["model"]
  readonly reasoning?: AgentReasoningLevel
  readonly caching?: "auto" | "off"
  readonly instructions: string
  readonly tools: readonly AgentToolDefinition[]
  readonly maxSteps: number
}

/** Adapt today's registered-agent definition to the source-neutral execution contract. */
export function resolveAgentExecutionPlan(input: {
  readonly agent: AgentDefinition
  readonly models?: LanguageModelCatalog
  readonly defaultMaxSteps: number
}): ResolvedAgentExecutionPlan {
  const { agent, models } = input
  const ref = { provider: agent.model.providerId, modelId: agent.model.modelId }
  const model = models?.getByRef(ref)?.model ?? (models === undefined ? agent.model : null)
  if (model === null) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbAgentWorker] Agent '${agent.id}' references language model '${ref.provider}/${ref.modelId}', which is missing from the runtime catalog.`,
      { details: { agentId: agent.id } }
    )
  }

  return Object.freeze({
    model,
    instructions: agent.instructions,
    tools: agent.tools,
    maxSteps: agent.loop?.stopWhen?.maxSteps ?? input.defaultMaxSteps,
    ...(agent.reasoning === undefined ? {} : { reasoning: agent.reasoning }),
    ...(agent.loop?.caching === undefined ? {} : { caching: agent.loop.caching }),
  })
}
