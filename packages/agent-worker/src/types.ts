import type {
  AgentStorage,
  AgentsRuntime,
  AuthStorage,
  Broker,
  EventsRuntime,
  Queues,
  SandboxFactory,
  Storage,
} from "@sixb/core"
import type { ToolSet } from "ai"
import type { StreamSink } from "./stream-sink"

// Keep root storage for transactions while making worker-required stores non-optional after setup.
export type AgentWorkerStorage = Storage & {
  readonly agents: AgentStorage
  readonly auth: AuthStorage
}

/**
 * The runtime surface the agent worker is constructed with (mirrors `ActionWorkerSixb`). `Sixb`
 * satisfies it structurally, so cohosting passes `sixb` directly. The worker resolves a run's model
 * via `agents.getById` (the model is a non-serialisable `LanguageModelV3`, never sent over the wire).
 */
export interface AgentWorkerSixb {
  readonly id: string
  readonly broker: Broker
  readonly events: EventsRuntime
  readonly storage: Storage
  readonly queues: Queues
  readonly agents: AgentsRuntime
  readonly sandboxes?: SandboxFactory
}

/**
 * The worker's derived, stable execution context (mirrors `ActionWorkerContext`): built once from
 * {@link AgentWorkerSixb} + options, then handed to each turn alongside the per-turn run. `id` is the
 * project id.
 */
export interface AgentWorkerContext {
  readonly id: string
  readonly storage: AgentWorkerStorage
  readonly sandboxes: SandboxFactory
  readonly baseTools: ToolSet
  readonly apiBaseUrl: string
  readonly streamSink: StreamSink
  readonly leaseMs: number
  readonly heartbeatMs: number
  readonly defaultMaxSteps: number
  readonly turnTimeoutMs: number
}

export interface AgentTurnContext {
  readonly id: string
  readonly storage: AgentWorkerStorage
  readonly tools: ToolSet
  readonly systemAddendum?: string
  readonly streamSink: StreamSink
  readonly leaseMs: number
  readonly heartbeatMs: number
  readonly defaultMaxSteps: number
  readonly turnTimeoutMs: number
}

export interface AgentWorkerOptions {
  /**
   * The `agent_runs` lease duration, in ms. Also used as the queue visibility timeout so that, on
   * redelivery, the run lease is already reclaimable. Defaults to 60s.
   */
  readonly leaseMs?: number
  /** Idle poll interval when the queue is empty, in ms. */
  readonly idlePollMs?: number
  /** Lease heartbeat interval during a turn, in ms. Defaults to `leaseMs / 3`. */
  readonly heartbeatMs?: number
  /**
   * Sixb server origin that hosts the agent API gateway, for example `http://localhost:3002`.
   * The sandbox receives a run-scoped gateway URL under this origin.
   */
  readonly apiBaseUrl: string
  /** Tools exposed to the model in addition to the built-in `bash` tool. */
  readonly tools?: ToolSet
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
