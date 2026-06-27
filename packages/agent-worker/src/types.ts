import type {
  AgentStorage,
  AgentsRuntime,
  AuthStorage,
  Broker,
  EventsRuntime,
  Queues,
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
}

/**
 * The worker's derived, stable execution context (mirrors `ActionWorkerContext`): built once from
 * {@link AgentWorkerSixb} + options, then handed to each turn alongside the per-turn run. `id` is the
 * project id.
 */
export interface AgentWorkerContext {
  readonly id: string
  readonly storage: AgentWorkerStorage
  readonly tools: ToolSet
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
  /** Tools exposed to the model. V1 ships an empty set; tests inject a generic tool. */
  readonly tools?: ToolSet
  /** Stream routing seam. Defaults to broker backed. */
  readonly streamSink?: StreamSink
  /** Step cap for agents that do not declare `loop.stopWhen.maxSteps`. Defaults to 8. */
  readonly defaultMaxSteps?: number
  /**
   * Wall-clock budget for a single turn, in ms. A turn that exceeds it is aborted and recorded
   * `failed`, releasing the thread — a slow-but-alive model cannot hold a thread indefinitely.
   * Defaults to 5 minutes.
   */
  readonly turnTimeoutMs?: number
}
