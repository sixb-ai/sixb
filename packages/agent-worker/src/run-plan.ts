import { type ResolvedAgentExecutionPlan, withBuiltInSkills } from "@sixb/agent"
import type { AgentStepDefinition, AgentToolDefinition, SixbDefinitions } from "@sixb/core"
import { type AgentRunPlan, listSandboxModels } from "@sixb/core/internal/agents"
import { createSixbError } from "@sixb/core/internal/errors"
import { selectLanguageModel } from "@sixb/core/internal/model-execution"

// The cloud runner holds the project, so it resolves what a plan names to the objects the harness
// calls: the model, and each project tool with its handler.

/** A turn's or a child's plan, with its model and tools resolved and the harness's skills added. */
export function resolveRunPlan(
  definitions: Pick<SixbDefinitions, "models" | "tools">,
  plan: AgentRunPlan
): ResolvedAgentExecutionPlan {
  const entry = definitions.models?.language?.getByRef(plan.model)
  if (!entry) {
    throw createSixbError(
      "agent.execution_failed",
      `[SixbAgentWorker] Language model '${plan.model.provider}/${plan.model.modelId}' is not available in models.language.`
    )
  }
  const tools = plan.toolNames.map((name): AgentToolDefinition => {
    const tool = definitions.tools.getByName(name)
    if (!tool) {
      throw createSixbError(
        "agent.execution_failed",
        `[SixbAgentWorker] Project tool '${name}' is not available.`,
        { details: { toolName: name } }
      )
    }
    return tool
  })
  const { reasoning, instructions, timeZone, locale, sandboxModels, ontologyDocs } = plan
  return Object.freeze({
    model: entry.model,
    ontologyDocs,
    ...(instructions === undefined ? {} : { instructions }),
    tools: Object.freeze(tools),
    skills: withBuiltInSkills(plan.skills),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(timeZone === undefined ? {} : { timeZone }),
    ...(locale === undefined ? {} : { locale }),
    ...(sandboxModels.length ? { sandboxModels } : {}),
  })
}

/**
 * Resolve a directly configured workflow task into the shared Agent execution contract: all but its
 * ontology docs, which its execution's view renders.
 */
export function resolveWorkflowAgentStepPlan(
  definitions: Pick<SixbDefinitions, "agent" | "models" | "tools">,
  input: { readonly workflowId: string; readonly step: AgentStepDefinition }
): Omit<ResolvedAgentExecutionPlan, "ontologyDocs"> {
  const { workflowId, step } = input
  const models = definitions.models?.language
  // The step's own model runs as given, listed in the catalog or not; a tier's comes from it.
  const selected = selectLanguageModel(models, step.model)
  if (selected === undefined) {
    const reference =
      typeof step.model === "string"
        ? `the model of tier '${step.model}'`
        : "the project default language model"
    throw createSixbError(
      "internal.unexpected",
      `[SixbAgentWorker] Workflow '${workflowId}' agent step '${step.id}' cannot resolve ${reference}.`,
      { details: { workflowId, agentStepId: step.id } }
    )
  }

  const tools = step.toolNames.map((name) => {
    const tool = definitions.tools.getByName(name)
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
    const skill = definitions.agent.skills.getByName(name)
    if (skill === null) {
      throw createSixbError(
        "internal.unexpected",
        `[SixbAgentWorker] Workflow '${workflowId}' agent step '${step.id}' cannot resolve Agent Skill '${name}'.`,
        { details: { workflowId, agentStepId: step.id, skillName: name } }
      )
    }
    return skill
  })

  const reasoning = step.reasoning ?? selected.defaultReasoning
  const sandboxModels = listSandboxModels(definitions.models)
  return Object.freeze({
    model: selected,
    instructions: step.instructions,
    tools: Object.freeze(tools),
    skills: Object.freeze(skills),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(sandboxModels.length ? { sandboxModels } : {}),
  })
}
