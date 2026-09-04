import type {
  AgentDefinition,
  AgentReasoningLevel,
  AgentStepDefinition,
  AgentToolCatalog,
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

/** Resolve a directly configured workflow task into the shared Agent execution contract. */
export function resolveWorkflowAgentStepExecutionPlan(input: {
  readonly workflowId: string
  readonly step: AgentStepDefinition
  readonly models?: LanguageModelCatalog
  readonly tools: AgentToolCatalog
  readonly defaultMaxSteps: number
}): ResolvedAgentExecutionPlan {
  const { workflowId, step, models } = input
  const model = resolveWorkflowAgentStepModel(step, models)
  if (model === null) {
    const reference =
      step.model === undefined
        ? "the project default language model"
        : `language model '${step.model.provider}/${step.model.modelId}'`
    throw createSixbError(
      "internal.unexpected",
      `[SixbAgentWorker] Workflow '${workflowId}' agent step '${step.id}' cannot resolve ${reference}.`,
      { details: { workflowId, agentStepId: step.id } }
    )
  }

  const tools = step.toolNames.map((name) => {
    const tool = input.tools.getByName(name)
    if (tool === null) {
      throw createSixbError(
        "internal.unexpected",
        `[SixbAgentWorker] Workflow '${workflowId}' agent step '${step.id}' cannot resolve project tool '${name}'.`,
        { details: { workflowId, agentStepId: step.id, toolName: name } }
      )
    }
    return tool
  })
  const providerOptions = withAutomaticPromptCaching(model, undefined)

  return Object.freeze({
    model,
    instructions: step.instructions,
    tools: Object.freeze(tools),
    maxSteps: input.defaultMaxSteps,
    ...(step.reasoning === undefined ? {} : { reasoning: step.reasoning }),
    ...(providerOptions === undefined ? {} : { providerOptions }),
  })
}

function resolveWorkflowAgentStepModel(
  step: AgentStepDefinition,
  models: LanguageModelCatalog | undefined
): AgentDefinition["model"] | null {
  if (step.model === undefined) return models?.default.model ?? null
  if (models === undefined) return step.model
  return models.getByRef(step.model)?.model ?? null
}
