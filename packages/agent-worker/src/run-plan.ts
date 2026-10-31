import type { ResolvedAgentExecutionPlan } from "@sixb/agent"
import type { AgentStepDefinition, SixbDefinitions } from "@sixb/core"
import { agentToolSpec, listSandboxModels } from "@sixb/core/internal/agents"
import { createSixbError } from "@sixb/core/internal/errors"
import { selectLanguageModel } from "@sixb/core/internal/model-execution"

// A turn's or a child's plan comes from its session, its model too. A workflow step runs only in the
// cloud, so the worker resolves its plan from the project's definitions.

/**
 * Resolve a directly configured workflow task into the shared Agent execution contract: all but its
 * ontology docs, which its execution's view renders.
 */
export function resolveWorkflowAgentStepPlan(
  definitions: Pick<SixbDefinitions, "agent" | "models" | "ontology" | "tools">,
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

  const valueTypesById = definitions.ontology.getValueTypesById()
  const tools = step.toolNames.map((name) => {
    const tool = definitions.tools.getByName(name)
    if (tool === null) {
      throw createSixbError(
        "internal.unexpected",
        `[SixbAgentWorker] Workflow '${workflowId}' agent step '${step.id}' cannot resolve project tool '${name}'.`,
        { details: { workflowId, agentStepId: step.id, toolName: name } }
      )
    }
    return agentToolSpec(tool, valueTypesById)
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
