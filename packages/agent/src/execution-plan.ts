import type { AgentReasoning, AgentSkillDefinition } from "@sixb/core"
import type { AgentRunPlan, AgentToolSpec, SandboxModel } from "@sixb/core/internal/agents"
import type { RenderedOntologyDocs } from "@sixb/core/internal/ontology"
import type { LanguageModel } from "@sixb/core/models"
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
  /** The project tools it offers, as the model is offered them; they run where the project is. */
  readonly tools: readonly AgentToolSpec[]
  /** Agent Skills installed in the sandbox and listed in the prompt. */
  readonly skills: readonly AgentSkillDefinition[]
  /** The requester's time zone and locale, when the run captured them. */
  readonly timeZone?: string
  readonly locale?: string
  /** Models the sandbox CLI can call beside the agent's own, listed in the prompt. */
  readonly sandboxModels?: readonly SandboxModel[]
  /** Reference docs for the object types the run's requester can see, from their own view. */
  readonly ontologyDocs: RenderedOntologyDocs
  /** At most this many model calls. Absent: it runs until its model answers. */
  readonly maxSteps?: number
}

/**
 * A turn's or a child's plan, with the session's model, which records each call itself, and the
 * harness's skills added. Its project tools run through the session.
 */
export function resolveRunPlan(
  plan: AgentRunPlan,
  resolved: { readonly model: LanguageModel }
): ResolvedAgentExecutionPlan {
  const {
    reasoning,
    instructions,
    timeZone,
    locale,
    sandboxModels,
    ontologyDocs,
    tools,
    maxSteps,
  } = plan
  return Object.freeze({
    model: resolved.model,
    ontologyDocs,
    ...(instructions === undefined ? {} : { instructions }),
    tools,
    skills: withBuiltInSkills(plan.skills),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(timeZone === undefined ? {} : { timeZone }),
    ...(locale === undefined ? {} : { locale }),
    ...(sandboxModels.length ? { sandboxModels } : {}),
    ...(maxSteps === undefined ? {} : { maxSteps }),
  })
}
