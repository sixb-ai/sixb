/**
 * A redelivered job found its run still owned by a live delivery: a duplicate job. The worker
 * leaves the run alone and retries the job once that delivery's projected lease lapses.
 */
export class AgentRunOwnedElsewhereError extends Error {
  readonly name = "AgentRunOwnedElsewhereError"
  constructor(
    readonly runId: string,
    readonly ownedUntil: Date
  ) {
    super(`[SixbAgentWorker] Agent run '${runId}' is still owned by another delivery.`)
  }
}
