import type {
  AgentReasoningLevel,
  AgentStepDefinition,
  AgentToolCatalog,
  AgentToolDefinition,
  LanguageModelCatalog,
  LanguageModelEntry,
} from "@sixb/core"
import { createSixbError } from "@sixb/core/internal/errors"
import type { LanguageModel } from "@sixb/core/models"
import type { ConversationAgentRunSpec, SubagentRunRecord } from "@sixb/core/storage"

const SUBAGENT_INSTRUCTIONS =
  "Complete the delegated task autonomously and return a concise result to the parent Agent."

/**
 * Fully resolved inputs shared by the agent execution engines.
 *
 * This internal runtime value is neither a durable run nor a public API contract. Source-specific
 * adapters resolve it before entering the shared execution path.
 */
export interface ResolvedAgentExecutionPlan {
  readonly model: LanguageModel
  readonly reasoning?: AgentReasoningLevel
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
  const entry = modelRef ? input.models?.getByRef(modelRef) : undefined
  if (!entry) {
    throw createSixbError(
      "agent.execution_failed",
      "[SixbAgentWorker] The conversation's language model is not available in models.language."
    )
  }
  // Admission freezes the model's default reasoning into the spec; only runs admitted before
  // specs existed take today's default.
  const reasoning = input.spec ? input.spec.reasoning : entry.reasoning
  return Object.freeze({
    model: entry.model,
    tools: input.tools.list(),
    maxSteps: input.defaultMaxSteps,
    ...(reasoning === undefined ? {} : { reasoning }),
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
  const selected = resolveWorkflowAgentStepModel(step, models)
  if (selected === null) {
    const reference =
      step.model === undefined
        ? "the project default language model"
        : `language model '${step.model.providerId}/${step.model.modelId}'`
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

  const reasoning = step.reasoning ?? selected.reasoning
  return Object.freeze({
    model: selected.model,
    instructions: step.instructions,
    tools: Object.freeze(tools),
    maxSteps: input.defaultMaxSteps,
    ...(reasoning === undefined ? {} : { reasoning }),
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

  return Object.freeze({
    model,
    instructions: SUBAGENT_INSTRUCTIONS,
    tools: Object.freeze(tools),
    maxSteps: run.spec.maxSteps,
    ...(run.spec.reasoning === undefined ? {} : { reasoning: run.spec.reasoning }),
  })
}

/** A catalog entry carries the model's default reasoning; a model outside a catalog has none. */
function resolveWorkflowAgentStepModel(
  step: AgentStepDefinition,
  models: LanguageModelCatalog | undefined
): Pick<LanguageModelEntry, "model" | "reasoning"> | null {
  if (step.model === undefined) return models?.default ?? null
  if (models === undefined) return { model: step.model }
  return models.getByRef({ provider: step.model.providerId, modelId: step.model.modelId })
}
