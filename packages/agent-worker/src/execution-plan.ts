import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider"
import type {
  AgentReasoningLevel,
  AgentStepDefinition,
  AgentToolCatalog,
  AgentToolDefinition,
  LanguageModelCatalog,
} from "@sixb/core"
import { createSixbError } from "@sixb/core/internal/errors"
import type { ConversationAgentRunSpec, SubagentRunRecord } from "@sixb/core/storage"
import { withAutomaticPromptCaching } from "./provider-caching"

const SUBAGENT_INSTRUCTIONS =
  "Complete the delegated task autonomously and return a concise result to the parent Agent."

/**
 * Fully resolved inputs shared by the agent execution engines.
 *
 * This internal runtime value is neither a durable run nor a public API contract. Source-specific
 * adapters resolve it before entering the shared execution path.
 */
export interface ResolvedAgentExecutionPlan {
  readonly model: LanguageModelV4
  readonly reasoning?: AgentReasoningLevel
  readonly providerOptions?: LanguageModelV4CallOptions["providerOptions"]
  readonly instructions?: string
  readonly tools: readonly AgentToolDefinition[]
  readonly maxSteps: number
}

/** Resolve the project's conversational Agent without a static definition. */
export function resolveAgentExecutionPlan(input: {
  readonly spec?: ConversationAgentRunSpec
  readonly models?: LanguageModelCatalog
  readonly tools: AgentToolCatalog
  readonly defaultMaxSteps: number
}): ResolvedAgentExecutionPlan {
  const modelRef = input.spec?.model ?? input.models?.default
  const model = modelRef ? input.models?.getByRef(modelRef)?.model : undefined
  if (!model) {
    throw createSixbError(
      "agent.execution_failed",
      "[SixbAgentWorker] The conversation's language model is not available in models.language."
    )
  }
  const providerOptions = withAutomaticPromptCaching(model, undefined)
  return Object.freeze({
    model,
    tools: input.tools.list(),
    maxSteps: input.defaultMaxSteps,
    ...(input.spec?.reasoning === undefined ? {} : { reasoning: input.spec.reasoning }),
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

/** Restore a headless child from the immutable model and tool selection captured at admission. */
export function resolveSubagentExecutionPlan(input: {
  readonly run: SubagentRunRecord
  readonly models?: LanguageModelCatalog
  readonly tools: AgentToolCatalog
}): ResolvedAgentExecutionPlan {
  const { run, models } = input
  const model = models?.getByRef(run.spec.model)?.model ?? null
  if (model === null) {
    throw createSixbError(
      "agent.execution_failed",
      `[SixbAgentWorker] Subagent run '${run.id}' cannot resolve language model '${run.spec.model.provider}/${run.spec.model.modelId}'.`,
      { details: { parentRunId: run.parentRunId, runId: run.id } }
    )
  }

  const tools = run.spec.toolNames.map((name) => {
    const definition = input.tools.getByName(name)
    if (definition === null) {
      throw createSixbError(
        "agent.execution_failed",
        `[SixbAgentWorker] Subagent run '${run.id}' cannot resolve project tool '${name}'.`,
        { details: { parentRunId: run.parentRunId, runId: run.id, toolName: name } }
      )
    }
    return definition
  })
  const providerOptions = withAutomaticPromptCaching(model, undefined)

  return Object.freeze({
    model,
    instructions: SUBAGENT_INSTRUCTIONS,
    tools: Object.freeze(tools),
    maxSteps: run.spec.maxSteps,
    ...(run.spec.reasoning === undefined ? {} : { reasoning: run.spec.reasoning }),
    ...(providerOptions === undefined ? {} : { providerOptions }),
  })
}

function resolveWorkflowAgentStepModel(
  step: AgentStepDefinition,
  models: LanguageModelCatalog | undefined
): LanguageModelV4 | null {
  if (step.model === undefined) return models?.default.model ?? null
  if (models === undefined) return step.model
  return models.getByRef(step.model)?.model ?? null
}
