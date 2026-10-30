import type { AgentReasoning, AgentSkillDefinition } from "@sixb/core"
import type { AgentToolSpec, SandboxModel } from "@sixb/core/internal/agents"
import type { RenderedOntologyDocs } from "@sixb/core/internal/ontology"
import type { LanguageModel } from "@sixb/core/models"

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
}
