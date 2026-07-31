const RETRY_BASE_DELAY_MS = 1_000
const RETRY_MAX_DELAY_MS = 5 * 60_000
const MAX_EXPONENT = Math.ceil(Math.log2(RETRY_MAX_DELAY_MS / RETRY_BASE_DELAY_MS))

/**
 * How long a telemetry run waits for the objects it appends to before failing.
 *
 * Measured from `run.startedAt`, not counted in deliveries: the queue increments `attempt` for
 * every redelivery, including ones caused by an unreachable Redis, so a delivery budget was spent
 * by trouble that had nothing to do with a missing object.
 *
 * Still a bound on time, and time is a proxy for a dependency nobody declared. The real answer is
 * for the orchestrator to hold a telemetry projection until the projection that owns its target
 * type's existence has succeeded — `validateProjectionOwnership` already computes that owner and
 * guarantees it is unique, so the dependency is derivable and does not belong in a retry policy.
 */
export const MISSING_TARGET_GRACE_MS = 2 * 60_000

/** Deterministic per-job jitter avoids synchronized retries while keeping tests reproducible. */
export function projectionRetryAvailableAt(input: {
  readonly jobId: string
  readonly attempt: number
  readonly now?: number
}): string {
  const attempt = Number.isSafeInteger(input.attempt) ? Math.max(1, input.attempt) : 1
  const exponent = Math.min(attempt - 1, MAX_EXPONENT)
  const ceiling = Math.min(RETRY_BASE_DELAY_MS * 2 ** exponent, RETRY_MAX_DELAY_MS)
  const jitter = 0.5 + stableFraction(`${input.jobId}:${attempt}`) * 0.5
  const delay = Math.max(1, Math.floor(ceiling * jitter))
  return new Date((input.now ?? Date.now()) + delay).toISOString()
}

function stableFraction(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) / 0xffffffff
}
