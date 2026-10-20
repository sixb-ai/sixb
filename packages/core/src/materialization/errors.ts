import { OntologyValidationError } from "../ontology/errors"

export type MaterializationConflictKind =
  | "idempotency"
  | "projection-fence"
  | "source-materialization"
  | "execution-lost"
  | "run-correlation"
  | "effective-state"
  /** A state the commit was told to expect (an Action's reads) no longer matches. */
  | "expectation"
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
  readonly name: string = "MaterializationValidationError"

  constructor(message: string, options?: ErrorOptions) {
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
    super(`Cannot append telemetry to missing object '${objectTypeId}:${primaryId}'.`)
  }
}

/**
 * A unique property value that another object of the type already holds.
 *
 * The message names only the type and the property, so a caller learns that the value is taken
 * and nothing more. The holder and the claimant are kept for messages that may name them.
 */
export class UniqueValueViolationError extends MaterializationValidationError {
  override readonly name = "UniqueValueViolationError"

  constructor(
    readonly objectTypeId: string,
    readonly propertyId: string,
    readonly holderPrimaryId: string,
    readonly claimantPrimaryId: string
  ) {
    super(`Another '${objectTypeId}' object already has this '${propertyId}'.`)
  }
}

/**
 * A write to a unique property whose stored values were never built, or were built with other
 * keys: `sixb db migrate` prepares them. Writes stay refused until then, rather than accept a
 * value they cannot check.
 */
export class UniquePropertyNotPreparedError extends Error {
  readonly name = "UniquePropertyNotPreparedError"

  constructor(
    readonly objectTypeId: string,
    readonly propertyId: string
  ) {
    super(
      `[Sixb] Unique property '${objectTypeId}.${propertyId}' is not prepared. Run \`sixb db migrate\`.`
    )
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
