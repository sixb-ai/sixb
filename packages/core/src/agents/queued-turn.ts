import type { Sixb } from "../runtime/sixb"
import type { AgentQueuedTurnStart } from "./request"

export type { AgentQueuedTurnStart }

const queuedTurnKey = Symbol("sixb.agentQueuedTurn")

interface QueuedTurnOwner {
  readonly [queuedTurnKey]?: (
    runId: string,
    options: { readonly onlyImmediate: boolean }
  ) => Promise<AgentQueuedTurnStart>
}

/**
 * Let code without a request start the next message someone queued for a thread: the worker's
 * session host, the API's, and the repair pass. The SDK it is given is bound to the request that
 * sent the message, so the message runs as the person who sent it.
 */
export function registerAgentQueuedTurn(
  agent: object,
  start: (
    runId: string,
    options: { readonly onlyImmediate: boolean }
  ) => Promise<AgentQueuedTurnStart>
): void {
  Object.defineProperty(agent, queuedTurnKey, {
    configurable: false,
    enumerable: false,
    value: start,
    writable: false,
  })
}

/** Start the bound SDK's principal's next queued message in `run`'s thread, once `run` ended. */
export function startQueuedAgentTurn(
  sixb: Sixb,
  runId: string,
  options: { readonly onlyImmediate: boolean }
): Promise<AgentQueuedTurnStart> {
  const start = (sixb.agent as QueuedTurnOwner)[queuedTurnKey]
  if (!start) {
    throw new Error("[Sixb] Queued Agent messages cannot start: Sixb did not bind this SDK.")
  }
  return start(runId, options)
}
