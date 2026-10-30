import type {
  AgentReasoning,
  AgentSkillCatalog,
  AgentSkillDefinition,
  AgentStepDefinition,
  AgentToolCatalog,
  AgentToolDefinition,
  LanguageModelCatalog,
  LanguageModelTier,
  ModelCatalog,
} from "@sixb/core"
import { createSixbError } from "@sixb/core/internal/errors"
import { selectLanguageModel } from "@sixb/core/internal/model-execution"
import type { LanguageModel } from "@sixb/core/models"
import type { ConversationAgentRunSpec, SubagentRunRecord } from "@sixb/core/storage"
import { withBuiltInSkills } from "./skills/built-in"

/**
 * Fully resolved inputs shared by the agent execution engines.
 *
 * This internal runtime value is neither a durable run nor a public API contract. Source-specific
 * adapters resolve it before entering the shared execution path.
 */
export interface ResolvedAgentExecutionPlan {
  readonly model: LanguageModel
  readonly reasoning?: AgentReasoning
  readonly instructions?: string
  readonly tools: readonly AgentToolDefinition[]
  /** Agent Skills installed in the sandbox and listed in the prompt. */
  readonly skills: readonly AgentSkillDefinition[]
  /** The requester's time zone and locale, when the run captured them. */
  readonly timeZone?: string
  readonly locale?: string
  /** Models the sandbox CLI can call beside the agent's own, listed in the prompt. */
  readonly sandboxModels?: readonly SandboxModel[]
}

export type SandboxModelKind = "language" | "image" | "speech" | "transcription"

/** One model the agent reaches through `sixb models`, as its prompt describes it. */
export interface SandboxModel {
  readonly kind: SandboxModelKind
  readonly provider: string
  readonly modelId: string
  /** A language model's tier, when the project configures its language models by tier. */
  readonly tier?: LanguageModelTier
  /** A language model's display name. */
  readonly name?: string
  readonly description?: string
}

/**
 * The project's models, with what each is for: its language models in catalog order, then each
 * media kind's, default first. Read from each model's configured definition, never its provider
 * catalog, so the prompt that lists them stays the same from turn to turn.
 */
export function listSandboxModels(models: ModelCatalog | undefined): readonly SandboxModel[] {
  return [...listLanguageModels(models?.language), ...listMediaModels(models)]
}

function listLanguageModels(catalog: LanguageModelCatalog | undefined): SandboxModel[] {
  return (catalog?.list() ?? []).map((entry) => {
    const { name, description } = entry.model.definition
    return {
      kind: "language",
      provider: entry.provider,
      modelId: entry.modelId,
      ...(entry.tier === undefined ? {} : { tier: entry.tier }),
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
    }
  })
}

function listMediaModels(models: ModelCatalog | undefined): SandboxModel[] {
  const kinds = [
    ["image", models?.image],
    ["speech", models?.audio?.speech],
    ["transcription", models?.audio?.transcription],
  ] as const
  return kinds.flatMap(([kind, catalog]) =>
    (catalog?.list() ?? []).map((entry) => {
      const description = entry.model.definition.description
      return {
        kind,
        provider: entry.provider,
        modelId: entry.modelId,
        ...(description ? { description } : {}),
      }
    })
  )
}

/**
 * Resolve the project's conversational Agent without a static definition. It receives every
 * project tool and skill, the worker's built-in skills, and the project's `SIXB.md` instructions.
 */
export function resolveAgentExecutionPlan(input: {
  readonly spec?: ConversationAgentRunSpec
  readonly models?: LanguageModelCatalog
  readonly tools: AgentToolCatalog
  readonly skills: AgentSkillCatalog
  readonly projectInstructions?: string
  readonly sandboxModels?: readonly SandboxModel[]
}): ResolvedAgentExecutionPlan {
  const modelRef = input.spec?.model ?? input.models?.default
  const entry = modelRef ? input.models?.getByRef(modelRef) : undefined
  if (!entry) {
    throw createSixbError(
      "agent.execution_failed",
      "[SixbAgent] The conversation's language model is not available in models.language."
    )
  }
  // Admission freezes the model's default reasoning into the spec; only runs admitted before
  // specs existed take today's default.
  const reasoning = input.spec ? input.spec.reasoning : entry.model.defaultReasoning
  return Object.freeze({
    model: entry.model,
    ...(input.projectInstructions === undefined ? {} : { instructions: input.projectInstructions }),
    tools: input.tools.list(),
    skills: withBuiltInSkills(input.skills.list()),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(input.spec?.timeZone === undefined ? {} : { timeZone: input.spec.timeZone }),
    ...(input.spec?.locale === undefined ? {} : { locale: input.spec.locale }),
    ...(input.sandboxModels?.length ? { sandboxModels: input.sandboxModels } : {}),
  })
}

/** Resolve a directly configured workflow task into the shared Agent execution contract. */
export function resolveWorkflowAgentStepExecutionPlan(input: {
  readonly workflowId: string
  readonly step: AgentStepDefinition
  readonly models?: LanguageModelCatalog
  readonly tools: AgentToolCatalog
  readonly skills: AgentSkillCatalog
  readonly sandboxModels?: readonly SandboxModel[]
}): ResolvedAgentExecutionPlan {
  const { workflowId, step, models } = input
  // The step's own model runs as given, listed in the catalog or not; a tier's comes from it.
  const selected = selectLanguageModel(models, step.model)
  if (selected === undefined) {
    const reference =
      typeof step.model === "string"
        ? `the model of tier '${step.model}'`
        : "the project default language model"
    throw createSixbError(
      "internal.unexpected",
      `[SixbAgent] Workflow '${workflowId}' agent step '${step.id}' cannot resolve ${reference}.`,
      { details: { workflowId, agentStepId: step.id } }
    )
  }

  const tools = step.toolNames.map((name) => {
    const tool = input.tools.getByName(name)
    if (tool === null) {
      throw createSixbError(
        "internal.unexpected",
        `[SixbAgent] Workflow '${workflowId}' agent step '${step.id}' cannot resolve project tool '${name}'.`,
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
        `[SixbAgent] Workflow '${workflowId}' agent step '${step.id}' cannot resolve Agent Skill '${name}'.`,
        { details: { workflowId, agentStepId: step.id, skillName: name } }
      )
    }
    return skill
  })

  const reasoning = step.reasoning ?? selected.defaultReasoning
  return Object.freeze({
    model: selected,
    instructions: step.instructions,
    tools: Object.freeze(tools),
    skills: Object.freeze(skills),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(input.sandboxModels?.length ? { sandboxModels: input.sandboxModels } : {}),
  })
}

/**
 * Restore a headless child from the immutable model and tool selection captured at admission. Like
 * its parent conversation, it receives every project skill, the worker's built-in skills, the
 * project's `SIXB.md` instructions, and its requester's settings.
 */
export function resolveSubagentExecutionPlan(input: {
  readonly run: SubagentRunRecord
  readonly models?: LanguageModelCatalog
  readonly tools: AgentToolCatalog
  readonly skills: AgentSkillCatalog
  readonly projectInstructions?: string
  readonly sandboxModels?: readonly SandboxModel[]
}): ResolvedAgentExecutionPlan {
  const { run, models } = input
  const model = models?.getByRef(run.spec.model)?.model ?? null
  if (model === null) {
    throw createSixbError(
      "agent.execution_failed",
      `[SixbAgent] Subagent run '${run.id}' cannot resolve language model '${run.spec.model.provider}/${run.spec.model.modelId}'.`,
      { details: { parentRunId: run.parentRunId, runId: run.id } }
    )
  }

  const tools = run.spec.toolNames.map((name) => {
    const definition = input.tools.getByName(name)
    if (definition === null) {
      throw createSixbError(
        "agent.execution_failed",
        `[SixbAgent] Subagent run '${run.id}' cannot resolve project tool '${name}'.`,
        { details: { parentRunId: run.parentRunId, runId: run.id, toolName: name } }
      )
    }
    return definition
  })

  const { reasoning, timeZone, locale } = run.spec
  return Object.freeze({
    model,
    ...(input.projectInstructions === undefined ? {} : { instructions: input.projectInstructions }),
    tools: Object.freeze(tools),
    skills: withBuiltInSkills(input.skills.list()),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(timeZone === undefined ? {} : { timeZone }),
    ...(locale === undefined ? {} : { locale }),
    ...(input.sandboxModels?.length ? { sandboxModels: input.sandboxModels } : {}),
  })
}
