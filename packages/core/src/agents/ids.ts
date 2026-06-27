import { randomUUID } from "node:crypto"

/**
 * Id helpers for agent persistence. Threads, the run id, and the user (trigger) message are minted
 * by the trigger; the worker still reserves the run row at claim time (reserve-at-claim), and the
 * assistant message id is minted when the turn finalizes. Prefixes make ids self-describing in logs.
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

/** A worker's lease id on an `agent_runs` record (distinct from the queue lease). */
export function createAgentRunLeaseId(): string {
  return `agt_lease_${randomUUID()}`
}
