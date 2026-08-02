import { SixbConflictError, SixbError, type SixbErrorOptions } from "../errors"
import { OntologyValidationError, type OntologyValidationErrorOptions } from "../ontology/errors"

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

/**
 * A validation failure raised inside the Materializer.
 *
 * Extends `OntologyValidationError` because it is the same class of failure a caller already
 * handles: batch writes surface it rewrapped as one, so a single write must not require a second
 * `instanceof` branch to catch the identical error.
 */
export class MaterializationValidationError extends OntologyValidationError {
  override readonly name: string = "MaterializationValidationError"

  constructor(message: string, options: OntologyValidationErrorOptions = {}) {
    super(prefixMessage(message), options)
  }
}

/** Structured missing-object failure raised by Materializer telemetry validation. */
export class MaterializationObjectNotFoundError extends MaterializationValidationError {
  override readonly name = "MaterializationObjectNotFoundError"

  constructor(
    readonly objectTypeId: string,
    readonly primaryId: string
  ) {
    super(`Cannot append telemetry to missing object '${objectTypeId}:${primaryId}'.`, {
      details: { objectTypeId, primaryId },
    })
  }
}

/**
 * Abort reason for an explicit, terminal cancellation of a materialization.
 *
 * Generic aborts (worker shutdown, delivery loss, timeout) remain retryable and preserve staged
 * source state. Passing this error as an AbortSignal reason authorizes that state to be abandoned.
 */
export class MaterializationCancellationError extends SixbError {
  override readonly name = "AbortError"

  constructor(message = "Materialization explicitly cancelled.", options: SixbErrorOptions = {}) {
    super("runtime.cancelled", prefixMessage(message), options)
  }
}

export class MaterializationConflictError extends SixbConflictError {
  override readonly name: string = "MaterializationConflictError"

  constructor(
    readonly kind: MaterializationConflictKind,
    message: string,
    options: SixbErrorOptions = {}
  ) {
    super("storage.conflict", prefixMessage(message), {
      ...options,
      details: { kind, ...options.details },
    })
  }
}

export function isMaterializationConflictError(
  error: unknown
): error is MaterializationConflictError {
  return error instanceof MaterializationConflictError
}
