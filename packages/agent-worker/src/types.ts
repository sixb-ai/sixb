import type {
  AgentToolRunContext,
  AuthorizablePrincipal,
  BlobStorage,
  Broker,
  DomainEventLog,
  Queues,
  SandboxFactory,
  SixbDefinitions,
  Storage,
  ValueType,
} from "@sixb/core"
import type { AgentExecutionHost } from "@sixb/core/internal/agent-execution"
import type { LoggingService } from "@sixb/core/internal/logging"
import type {
  AgentStorage,
  AiUsageStorage,
  AuthStorage,
  RecordAiModelCallInput,
} from "@sixb/core/storage"
import type { ToolSet } from "ai"
import type { AgentSkill } from "./agent-skills"
import type { PreparedAgentAttachmentContext } from "./attachments"
import type { BashSandboxHandle } from "./bash-tool"
import type { StreamSink } from "./stream-sink"

// Keep root storage for transactions while making worker-required stores non-optional after setup.
export type AgentWorkerStorage = Storage & {
  readonly agents: AgentStorage
  readonly aiUsage: AiUsageStorage
  readonly auth: AuthStorage
}

export type RecoverAiModelCall = (record: RecordAiModelCallInput) => Promise<void>

/**
 * The host surface the agent worker is constructed with. `SixbHost` satisfies it structurally, so
 * cohosting passes the host directly. The worker resolves a run's model through
 * `definitions.agents.getById` (the model is a non-serialisable language model, never sent over the
 * wire).
 */
export interface AgentWorkerHost extends AgentExecutionHost {
  readonly broker: Broker
  readonly events: DomainEventLog
  readonly storage: Storage
  readonly queues: Queues
  readonly definitions: Pick<SixbDefinitions, "agents" | "workflows" | "ontology" | "security">
  readonly sandboxes?: SandboxFactory
  readonly projectRoot?: string
  readonly logging?: LoggingService
}

/**
 * The worker's derived, stable execution context (mirrors `ActionWorkerContext`): built once from
 * {@link AgentWorkerHost} + options, then handed to each turn alongside the per-turn run. `id` is the
 * project id.
 */
export interface AgentWorkerContext {
  readonly id: string
  readonly storage: AgentWorkerStorage
  readonly sandboxes: SandboxFactory
  readonly logging?: LoggingService
  readonly valueTypesById: ReadonlyMap<string, ValueType>
  readonly apiBaseUrl: string
  readonly streamSink: StreamSink
  /** Durable fallback used only when the direct model-call ledger append remains unavailable. */
  readonly recoverAiModelCall: RecoverAiModelCall
  readonly agentSkills: Promise<readonly AgentSkill[]>
  readonly defaultMaxSteps: number
  readonly turnTimeoutMs: number
}

/** The identity a run executes as: its own service account, or the human it acts for. */
export type AgentPrincipal = AuthorizablePrincipal

/** Provider ports activated only after an agent service-account scope is bound. */
export interface AgentExecutionContext extends AgentWorkerContext {
  readonly agentPrincipal: AgentPrincipal
  readonly blobStorage: BlobStorage
  readonly connector: AgentToolRunContext["connector"]
}

export interface AgentTurnContext {
  readonly id: string
  readonly agentPrincipal: AgentPrincipal
  readonly storage: AgentWorkerStorage
  readonly blobStorage: BlobStorage
  /** Run-scoped agent API gateway base URL, when this turn was created through a run environment. */
  readonly apiBaseUrl?: string
  readonly tools: ToolSet
  readonly systemAddendum?: string
  readonly attachmentContext?: PreparedAgentAttachmentContext
  /**
   * The concurrently provisioning sandbox, exposed so the turn can fail if it rejects. Resolved
   * value is irrelevant here (the bash tool consumes the handle); only its rejection matters.
   */
  readonly sandboxReady?: Promise<BashSandboxHandle>
  readonly sandboxWasUsed?: () => boolean
  /**
   * Surface a failure an injected tool retained because the AI SDK turned it into tool-result text.
   * Called before the turn interprets its stream.
   */
  readonly assertToolsHealthy?: () => void
  readonly streamSink: StreamSink
  readonly recoverAiModelCall: RecoverAiModelCall
  readonly defaultMaxSteps: number
  readonly turnTimeoutMs: number
}

export interface AgentWorkerOptions {
  /** Queue visibility duration, renewed automatically while a turn executes. Defaults to 60s. */
  readonly leaseMs?: number
  /** Idle poll interval when the queue is empty, in ms. */
  readonly idlePollMs?: number
  /**
   * Sixb server origin that hosts the agent API gateway, for example `http://localhost:3002`.
   * The sandbox receives a run-scoped gateway URL under this origin.
   */
  readonly apiBaseUrl: string
  /** Project Agent Skills directory. Defaults to `<projectRoot>/skills`; `false` disables project skills. */
  readonly skillsDir?: string | false
  /** Maximum number of agent run jobs this worker claims and executes at once. Defaults to 4. */
  readonly concurrency?: number
  /** Stream routing seam. Defaults to broker backed. */
  readonly streamSink?: StreamSink
  /** Step cap for agents that do not declare `loop.stopWhen.maxSteps`. Defaults to 25. */
  readonly defaultMaxSteps?: number
  /**
   * Wall-clock budget for a single turn, in ms. A turn that exceeds it is aborted and recorded
   * `failed`, releasing the thread — a slow-but-alive model cannot hold a thread indefinitely.
   * Defaults to 5 minutes.
   */
  readonly turnTimeoutMs?: number
}
