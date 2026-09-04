import type {
  AgentDefinition,
  AgentReasoningLevel,
  AgentToolDefinition,
  LanguageModelCatalog,
} from "@sixb/core"
import { createSixbError } from "@sixb/core/internal/errors"
import { withAutomaticPromptCaching } from "./provider-caching"

/**
 * Fully resolved inputs shared by the agent execution engines.
 *
 * This internal runtime value is neither a durable run nor a public API contract. Source-specific
 * adapters resolve it before entering the shared execution path.
 */
export interface ResolvedAgentExecutionPlan {
  readonly model: AgentDefinition["model"]
  readonly reasoning?: AgentReasoningLevel
  readonly providerOptions?: NonNullable<AgentDefinition["providerOptions"]>
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
  const model = models?.getByRef(agent.model)?.model ?? (models === undefined ? agent.model : null)
  if (model === null) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbAgentWorker] Agent '${agent.id}' references language model '${agent.model.provider}/${agent.model.modelId}', which is missing from the runtime catalog.`,
      { details: { agentId: agent.id } }
    )
  }

  const providerOptions =
    agent.loop?.caching === "off"
      ? agent.providerOptions
      : withAutomaticPromptCaching(model, agent.providerOptions)

  return Object.freeze({
    model,
    instructions: agent.instructions,
    tools: agent.tools,
    maxSteps: agent.loop?.stopWhen?.maxSteps ?? input.defaultMaxSteps,
    ...(agent.reasoning === undefined ? {} : { reasoning: agent.reasoning }),
    ...(providerOptions === undefined ? {} : { providerOptions }),
  })
}
