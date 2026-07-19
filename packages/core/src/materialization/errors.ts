export type MaterializationConflictKind =
  | "idempotency"
  | "projection-fence"
  | "source-materialization"
  | "execution-lost"
  | "run-correlation"
  | "effective-state"
  | "timeseries-point"
  | "outbox-lease"

function prefixMessage(message: string): string {
  return message.startsWith("[Sixb]") ? message : `[Sixb] ${message}`
}

export class MaterializationValidationError extends Error {
  readonly name: string = "MaterializationValidationError"

  constructor(message: string) {
    super(prefixMessage(message))
  }
}

/**
 * Abort reason for an explicit, terminal cancellation of a materialization.
 *
 * Generic aborts (worker shutdown, delivery loss, timeout) remain retryable and preserve staged
 * source state. Passing this error as an AbortSignal reason authorizes that state to be abandoned.
 */
export class MaterializationCancellationError extends Error {
  readonly name = "AbortError"

  constructor(message = "Materialization explicitly cancelled.", options?: ErrorOptions) {
    super(prefixMessage(message), options)
  }
}

export class MaterializationConflictError extends Error {
  readonly name: string = "MaterializationConflictError"

  constructor(
    readonly kind: MaterializationConflictKind,
    message: string
  ) {
    super(prefixMessage(message))
  }
}

export function isMaterializationConflictError(
  error: unknown
): error is MaterializationConflictError {
  return error instanceof MaterializationConflictError
}
