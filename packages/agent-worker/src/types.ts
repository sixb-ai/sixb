import type { BlobStorage, Broker, Queues, SandboxFactory, Storage } from "@sixb/core"
import type { AgentsRuntime } from "@sixb/core/internal/agents"
import type { EventsRuntime } from "@sixb/core/internal/events"
import type { AgentStorage, AuthStorage } from "@sixb/core/storage"
import type { ToolSet } from "ai"
import type { AgentSkill } from "./agent-skills"
import type { PreparedAgentAttachmentContext } from "./attachments"
import type { BashSandboxHandle } from "./bash-tool"
import type { StreamSink } from "./stream-sink"

// Keep root storage for transactions while making worker-required stores non-optional after setup.
export type AgentWorkerStorage = Storage & {
  readonly agents: AgentStorage
  readonly auth: AuthStorage
}

/**
 * The runtime surface the agent worker is constructed with (mirrors `ActionWorkerSixb`). `Sixb`
 * satisfies it structurally, so cohosting passes `sixb` directly. The worker resolves a run's model
 * via `agents.getById` (the model is a non-serialisable language model, never sent over the wire).
 */
export interface AgentWorkerSixb {
  readonly id: string
  readonly broker: Broker
  readonly events: EventsRuntime
  readonly storage: Storage
  readonly queues: Queues
  readonly agents: AgentsRuntime
  readonly blobStorage: BlobStorage
  readonly sandboxes?: SandboxFactory
  readonly projectRoot?: string
}

/**
 * The worker's derived, stable execution context (mirrors `ActionWorkerContext`): built once from
 * {@link AgentWorkerSixb} + options, then handed to each turn alongside the per-turn run. `id` is the
 * project id.
 */
export interface AgentWorkerContext {
  readonly id: string
  readonly storage: AgentWorkerStorage
  readonly blobStorage: BlobStorage
  readonly sandboxes: SandboxFactory
  readonly baseTools: ToolSet
  readonly apiBaseUrl: string
  readonly streamSink: StreamSink
  readonly agentSkills: Promise<readonly AgentSkill[]>
  readonly defaultMaxSteps: number
  readonly turnTimeoutMs: number
}

export interface AgentTurnContext {
  readonly id: string
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
  readonly streamSink: StreamSink
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
  /** Tools exposed to the model in addition to the built-in `bash` tool. */
  readonly tools?: ToolSet
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
