import type {
  AgentReasoningLevel,
  AgentSkillCatalog,
  AgentSkillDefinition,
  AgentStepDefinition,
  AgentToolCatalog,
  AgentToolDefinition,
  LanguageModelCatalog,
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
  /** Agent Skills installed in the sandbox and listed in the prompt. */
  readonly skills: readonly AgentSkillDefinition[]
  readonly maxSteps: number
}

/**
 * Resolve the project's conversational Agent without a static definition. It receives every
 * project tool and skill, and the project's `SIXB.md` instructions.
 */
export function resolveAgentExecutionPlan(input: {
  readonly spec?: ConversationAgentRunSpec
  readonly models?: LanguageModelCatalog
  readonly tools: AgentToolCatalog
  readonly skills: AgentSkillCatalog
  readonly projectInstructions?: string
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
  return Object.freeze({
    model,
    ...(input.projectInstructions === undefined ? {} : { instructions: input.projectInstructions }),
    tools: input.tools.list(),
    skills: input.skills.list(),
    maxSteps: input.defaultMaxSteps,
    ...(input.spec?.reasoning === undefined ? {} : { reasoning: input.spec.reasoning }),
  })
}

/** Resolve a directly configured workflow task into the shared Agent execution contract. */
export function resolveWorkflowAgentStepExecutionPlan(input: {
  readonly workflowId: string
  readonly step: AgentStepDefinition
  readonly models?: LanguageModelCatalog
  readonly tools: AgentToolCatalog
  readonly skills: AgentSkillCatalog
  readonly defaultMaxSteps: number
}): ResolvedAgentExecutionPlan {
  const { workflowId, step, models } = input
  const model = resolveWorkflowAgentStepModel(step, models)
  if (model === null) {
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

  const skills = step.skillNames.map((name) => {
    const skill = input.skills.getByName(name)
    if (skill === null) {
      throw createSixbError(
        "internal.unexpected",
        `[SixbAgentWorker] Workflow '${workflowId}' agent step '${step.id}' cannot resolve Agent Skill '${name}'.`,
        { details: { workflowId, agentStepId: step.id, skillName: name } }
      )
    }
    return skill
  })

  return Object.freeze({
    model,
    instructions: step.instructions,
    tools: Object.freeze(tools),
    skills: Object.freeze(skills),
    maxSteps: input.defaultMaxSteps,
    ...(step.reasoning === undefined ? {} : { reasoning: step.reasoning }),
  })
}

/**
 * Restore a headless child from the immutable model and tool selection captured at admission. It
 * receives every project skill, like its parent conversation.
 */
export function resolveSubagentExecutionPlan(input: {
  readonly run: SubagentRunRecord
  readonly models?: LanguageModelCatalog
  readonly tools: AgentToolCatalog
  readonly skills: AgentSkillCatalog
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
    skills: input.skills.list(),
    maxSteps: run.spec.maxSteps,
    ...(run.spec.reasoning === undefined ? {} : { reasoning: run.spec.reasoning }),
  })
}

function resolveWorkflowAgentStepModel(
  step: AgentStepDefinition,
  models: LanguageModelCatalog | undefined
): LanguageModel | null {
  if (step.model === undefined) return models?.default.model ?? null
  if (models === undefined) return step.model
  return (
    models.getByRef({ provider: step.model.providerId, modelId: step.model.modelId })?.model ?? null
  )
}
