const RETRY_BASE_DELAY_MS = 1_000
const RETRY_MAX_DELAY_MS = 5 * 60_000
const MAX_EXPONENT = Math.ceil(Math.log2(RETRY_MAX_DELAY_MS / RETRY_BASE_DELAY_MS))

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
