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
 * Let code without a request start the next message a finished turn's requester queued for its
 * thread: the worker's session host, the API's, and the repair pass. The SDK it is given is bound
 * to the finished turn's execution, so the message runs as the person who sent it.
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

/** Start the next queued message of `run`'s thread, as the bound SDK's principal, its requester. */
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
