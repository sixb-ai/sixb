import type {
  AgentStorage,
  AgentsRuntime,
  EventsRuntime,
  Queues,
  SixbMessagePart,
  Storage,
} from "@sixb/core"
import type { ToolSet } from "ai"

/**
 * The runtime surface the agent worker is constructed with (mirrors `ActionWorkerSixb`). `Sixb`
 * satisfies it structurally, so cohosting passes `sixb` directly. The worker resolves a run's model
 * via `agents.getById` (the model is a non-serialisable `LanguageModelV3`, never sent over the wire).
 */
export interface AgentWorkerSixb {
  readonly id: string
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
  readonly storage: AgentStorage
  readonly tools: ToolSet
  readonly streamSink: StreamSink
  readonly leaseMs: number
  readonly heartbeatMs: number
  readonly defaultMaxSteps: number
}

/**
 * Where the loop routes streamed assistant parts. **No-op in production for this slice** — the
 * stream is meant to flow through the broker on a dedicated per-run channel, which is a later slice.
 * Baking the seam now keeps that slice a pure addition (provide a real sink) with zero loop change.
 * A sink failure is isolated by the loop: it never blocks the turn or the lease heartbeat.
 */
export interface StreamSink {
  onPart(part: SixbMessagePart): void | Promise<void>
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
  /** Stream routing seam. Defaults to a no-op sink. */
  readonly streamSink?: StreamSink
  /** Step cap for agents that do not declare `loop.stopWhen.maxSteps`. Defaults to 8. */
  readonly defaultMaxSteps?: number
}
