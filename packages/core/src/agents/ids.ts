import { randomUUID } from "node:crypto"

/**
 * Id helpers for agent persistence. Threads, the run id, and the user (trigger) message are minted
 * by the trigger; the queued run is persisted with the user message, and the assistant message id
 * is minted when the turn finalizes. Prefixes make ids self-describing in logs.
 */

export function createAgentThreadId(): string {
  return `agt_thr_${randomUUID()}`
}

export function createAgentRunId(): string {
  return `agt_run_${randomUUID()}`
}

export function createAgentMessageId(): string {
  return `agt_msg_${randomUUID()}`
}

/** A queue delivery's fencing token for writes to an `agent_runs` record. */
export function createAgentRunExecutionToken(): string {
  return `agt_exec_${randomUUID()}`
}
