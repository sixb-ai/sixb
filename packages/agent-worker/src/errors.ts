/** Infra-level failure in the agent worker (unknown agent, missing storage, malformed job). */
export class AgentWorkerError extends Error {
  readonly name = "AgentWorkerError"
  constructor(message: string, options?: ErrorOptions) {
    super(`[SixbAgentWorker] ${message}`, options)
  }
}

/**
 * The thread's active run is still held by a live worker (its `agent_runs` lease has not expired),
 * so this delivery cannot take it over yet. The worker retries the job at {@link availableAt}.
 */
export class AgentLeaseHeldError extends Error {
  readonly name = "AgentLeaseHeldError"
  constructor(
    readonly availableAt: string,
    message: string
  ) {
    super(`[SixbAgentWorker] ${message}`)
  }
}

/**
 * This worker lost the run's lease mid-turn (it was reclaimed by another worker after a crash was
 * suspected). The run now belongs to someone else, so this worker writes nothing further and simply
 * acknowledges its — now duplicate — delivery.
 */
export class AgentLeaseLostError extends Error {
  readonly name = "AgentLeaseLostError"
  constructor(readonly runId: string) {
    super(`[SixbAgentWorker] Lost the lease on agent run '${runId}'; another worker owns it.`)
  }
}
