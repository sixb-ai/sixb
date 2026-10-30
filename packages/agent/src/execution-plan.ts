import type { AgentReasoning, AgentSkillDefinition, AgentToolDefinition } from "@sixb/core"
import type { SandboxModel } from "@sixb/core/internal/agents"
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
  readonly tools: readonly AgentToolDefinition[]
  /** Agent Skills installed in the sandbox and listed in the prompt. */
  readonly skills: readonly AgentSkillDefinition[]
  /** The requester's time zone and locale, when the run captured them. */
  readonly timeZone?: string
  readonly locale?: string
  /** Models the sandbox CLI can call beside the agent's own, listed in the prompt. */
  readonly sandboxModels?: readonly SandboxModel[]
}
