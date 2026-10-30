import type { AgentExecutionContext, AgentRunSettings } from "@sixb/agent"
import type {
  Broker,
  DomainEventLog,
  Queues,
  SandboxDefinition,
  SandboxFactory,
  SixbDefinitions,
  Storage,
} from "@sixb/core"
import type { AgentExecutionHost } from "@sixb/core/internal/agent-execution"
import type { StreamSink } from "@sixb/core/internal/agents"
import type { LoggingService } from "@sixb/core/internal/logging"
import type { RecoverAiModelCall } from "@sixb/core/internal/model-execution"
import type {
  AgentStorage,
  AiCostStorage,
  AiLimitStorage,
  AiUsageStorage,
  AuthStorage,
} from "@sixb/core/storage"

// Keep root storage for transactions while making worker-required stores non-optional after setup.
export type AgentWorkerStorage = Storage & {
  readonly agents: AgentStorage
  readonly aiUsage: AiUsageStorage
  readonly aiCosts: AiCostStorage
  readonly aiLimits: AiLimitStorage
  readonly auth: AuthStorage
}

/**
 * The host surface the agent worker is constructed with. `SixbHost` satisfies it structurally, so
 * cohosting passes the host directly. Project capabilities and workflow Agent steps provide execution
 * configuration; the model catalog provides the conversational Agent's live model binding.
 * Models are non-serialisable and never sent over the wire.
 */
export interface AgentWorkerHost extends AgentExecutionHost {
  /** Project locale and time zone, for runs that do not carry the requester's own. */
  readonly locale: string
  readonly timeZone: string
  readonly sandboxDefinition?: SandboxDefinition
  readonly broker: Broker
  readonly events: DomainEventLog
  readonly storage: Storage
  readonly queues: Queues
  readonly definitions: Pick<
    SixbDefinitions,
    "workflows" | "ontology" | "security" | "models" | "tools" | "agent"
  >
  readonly sandboxes?: SandboxFactory
  readonly logging?: LoggingService
}

/**
 * The worker's derived, stable execution context: built once from {@link AgentWorkerHost} +
 * options, then handed to each turn alongside the per-turn run. `id` is the project id.
 */
export interface AgentWorkerContext extends AgentRunSettings {
  readonly storage: AgentWorkerStorage
  readonly sandboxes: SandboxFactory
  readonly streamSink: StreamSink
  /** Durable fallback used only when the direct model-call ledger append remains unavailable. */
  readonly recoverAiModelCall: RecoverAiModelCall
}

/**
 * Provider ports activated only after an Agent execution scope is bound. A run reaches shared
 * state through its session; the worker's storage is not part of it.
 */
export interface AgentWorkerOptions {
  /** Queue visibility duration, renewed automatically while a turn executes. Defaults to 60s. */
  readonly leaseMs?: number
  /**
   * Sixb server origin the run's commands call with their run token, for example
   * `http://localhost:3001`.
   */
  /** Not required when the worker only processes accounting recovery. */
  readonly apiBaseUrl?: string
  /** Maximum number of primary agent jobs this worker executes at once. Defaults to 8. */
  readonly concurrency?: number
  /**
   * Maximum number of child agents this worker runs at once, across its turns. A child over it
   * waits queued for a slot. Defaults to 4.
   */
  readonly subagentConcurrency?: number
  /**
   * Maximum number of child agents one conversation turn may have queued or running at once. They
   * run in its worker, under its delivery. Defaults to 4.
   */
  readonly subagentConcurrencyPerRun?: number
  /** Stream routing seam. Defaults to broker backed. */
  readonly streamSink?: StreamSink
  /** Framework model step cap per turn. Defaults to 100. */
  readonly defaultMaxSteps?: number
  /**
   * Wall-clock budget for a single turn, in ms. A turn that exceeds it is aborted and recorded
   * `failed`, releasing the thread — a slow-but-alive model cannot hold a thread indefinitely.
   * Defaults to 10 minutes.
   */
  readonly turnTimeoutMs?: number
}

/** A run's execution context as the cloud runner holds it: with the factory its sandboxes come from. */
export type AgentRunnerContext = AgentExecutionContext & Pick<AgentWorkerContext, "sandboxes">
