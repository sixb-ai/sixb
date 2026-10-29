import type {
  AuthorizablePrincipal,
  BlobStorage,
  Broker,
  DomainEventLog,
  OntologyDocsCatalog,
  Queues,
  SandboxDefinition,
  SandboxFactory,
  Sixb,
  SixbDefinitions,
  Storage,
  ValueType,
} from "@sixb/core"
import type { AgentExecutionHost } from "@sixb/core/internal/agent-execution"
import type { PropertyClearance, RunModelLoopInput } from "@sixb/core/internal/agents"
import type { LoggingService } from "@sixb/core/internal/logging"
import type { RecoverAiModelCall } from "@sixb/core/internal/model-execution"
import type { ModelTool } from "@sixb/core/models"
import type {
  AgentStorage,
  AiCostStorage,
  AiLimitStorage,
  AiUsageStorage,
  AuthStorage,
} from "@sixb/core/storage"
import type { PreparedAgentAttachmentContext } from "./attachments"
import type { AgentRequester } from "./requester"
import type { BeforeFinalizeOptions } from "./run-sandbox"
import type { AgentSandboxHandle } from "./sandbox-handle"
import type { StreamSink } from "./stream-sink"
import type { AgentFileBudget } from "./tools/tool-files"

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
export interface AgentWorkerContext {
  readonly id: string
  readonly storage: AgentWorkerStorage
  readonly sandboxes: SandboxFactory
  readonly logging?: LoggingService
  readonly valueTypesById: ReadonlyMap<string, ValueType>
  readonly ontologyDocs: OntologyDocsCatalog
  readonly apiBaseUrl: string
  readonly streamSink: StreamSink
  /** Durable fallback used only when the direct model-call ledger append remains unavailable. */
  readonly recoverAiModelCall: RecoverAiModelCall
  readonly defaultMaxSteps: number
  readonly turnTimeoutMs: number
  /** How many children one conversation turn may have queued or running at once. */
  readonly subagentConcurrencyPerRun: number
  /** Project locale and time zone, for runs that do not carry the requester's own. */
  readonly locale: string
  readonly timeZone: string
}

/** Provider ports activated only after an Agent execution scope is bound. */
export interface AgentExecutionContext extends AgentWorkerContext {
  readonly sixb: Sixb
  /** Marked properties the execution cannot read; absent when it reads every property. Their docs flag them. */
  readonly propertyClearance?: PropertyClearance
  readonly authorPrincipal?: AuthorizablePrincipal
  /**
   * Who the run works for; absent when no principal started its chain of executions, or in a
   * shared thread, where each user message names its author instead.
   */
  readonly requester?: AgentRequester
  readonly blobStorage: BlobStorage
}

export interface AgentTurnContext {
  /** Environment-owned failure (for example lost source credentials), not user cancellation. */
  readonly environmentFailureSignal?: AbortSignal
  /** Persistent environments must confirm cleanup/save before any terminal write. */
  readonly beforeFinalize?: (options?: BeforeFinalizeOptions) => Promise<void>
  readonly id: string
  readonly authorPrincipal?: AuthorizablePrincipal
  readonly storage: AgentWorkerStorage
  readonly blobStorage: BlobStorage
  /** The Sixb API the run's commands call, when this turn was created through a run environment. */
  readonly apiBaseUrl?: string
  readonly tools: readonly ModelTool[]
  readonly prepareStep?: RunModelLoopInput["prepareStep"]
  /** Complete worker-owned system prompt, derived from the mode and provisioned runtime. */
  readonly systemPrompt: string
  /** Time zone of runs that captured none, used to date their user messages. */
  readonly projectTimeZone: string
  /** Prepared by the run's environment, which materializes the files in its context directory. */
  readonly attachmentContext?: PreparedAgentAttachmentContext
  /**
   * The concurrently provisioning sandbox, exposed so the turn can fail if it rejects. Resolved
   * value is irrelevant here (the sandbox tools consume the handle); only its rejection matters.
   */
  readonly sandboxReady?: Promise<AgentSandboxHandle>
  readonly streamSink: StreamSink
  readonly recoverAiModelCall: RecoverAiModelCall
  readonly turnTimeoutMs: number
}

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
   * Maximum number of child agents this worker executes at once, on a lane of their own so
   * waiting parents never hold their slots. Defaults to 4.
   */
  readonly subagentConcurrency?: number
  /**
   * Maximum number of child agents one conversation turn may have queued or running at once,
   * across every worker. Defaults to 4.
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

/**
 * A run's sandbox and its stored files, as its framework tools use them: a parent hands files to
 * its children and gets theirs back, a child returns what it wrote.
 */
export interface AgentRunFiles {
  sandbox(): Promise<AgentSandboxHandle>
  readonly blobStorage: BlobStorage
  /** Shared with every other file the run stores. */
  readonly budget: AgentFileBudget
  /**
   * Install the latest version of each artifact these runs published in the thread in the run's
   * `$SIXB_ARTIFACTS`; nothing for a run that installs no artifacts. Throws, naming them, when
   * some could not be installed.
   */
  installArtifactsFrom(runIds: readonly string[], signal: AbortSignal): Promise<void>
}
