import { isSixbError, SixbError, type SixbErrorOptions, toSixbFailure } from "../errors"

const MATERIALIZATION_CONFLICT_KINDS = [
  "idempotency",
  "projection-fence",
  "source-materialization",
  "execution-lost",
  "run-correlation",
  "effective-state",
  "timeseries-point",
  "outbox-lease",
] as const

export type MaterializationConflictKind = (typeof MATERIALIZATION_CONFLICT_KINDS)[number]

function prefixMessage(message: string): string {
  return message.startsWith("[Sixb]") ? message : `[Sixb] ${message}`
}

/**
 * A materialization refused because the state moved underneath it.
 *
 * `kind` is the branch a caller writes — a lost projection fence is terminal, a reclaimed execution
 * is redelivered — so it travels in `details` where the run row and the wire both keep it. Read it
 * back with {@link materializationConflictKind}.
 */
export function materializationConflict(
  kind: MaterializationConflictKind,
  message: string,
  options: SixbErrorOptions = {}
): SixbError {
  return new SixbError("storage.conflict", prefixMessage(message), {
    ...options,
    details: { kind, ...options.details },
  })
}

/** The conflict `kind` this failure carries, or `undefined` when it is not a materialization conflict. */
export function materializationConflictKind(
  error: unknown
): MaterializationConflictKind | undefined {
  if (!isSixbError(error, "storage.conflict")) return undefined
  const kind = toSixbFailure(error).details?.kind
  return MATERIALIZATION_CONFLICT_KINDS.find((candidate) => candidate === kind)
}

/**
 * An explicit, terminal cancellation of a materialization, shaped as an `AbortSignal` reason.
 *
 * Generic aborts (worker shutdown, delivery loss, timeout) stay retryable and preserve staged source
 * state. Aborting with this instead authorizes that state to be abandoned, which is what
 * `details.cancellation` records and {@link isMaterializationCancellation} reads. The code alone
 * cannot say it: every abort in the codebase reports `runtime.cancelled`.
 */
export function materializationCancelled(
  message = "Materialization explicitly cancelled.",
  options: SixbErrorOptions = {}
): SixbError {
  const error = new SixbError("runtime.cancelled", prefixMessage(message), {
    ...options,
    details: { cancellation: "explicit", ...options.details },
  })
  // Assigned through `Error` because `SixbError` declares `name` readonly. `QueueWorker` routes on
  // this name, so without it the run is retried while it is still `running` instead of failed —
  // the same move `createAbortError` makes for a plain `Error`.
  const abortShaped: Error = error
  abortShaped.name = "AbortError"
  return error
}

/** Whether this failure is the explicit cancellation {@link materializationCancelled} builds. */
export function isMaterializationCancellation(error: unknown): boolean {
  return (
    isSixbError(error, "runtime.cancelled") &&
    toSixbFailure(error).details?.cancellation === "explicit"
  )
}
