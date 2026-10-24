import {
  createSixbError,
  type SixbCodedError,
  type SixbErrorOptions,
  withFailureMessage,
} from "../errors/internal"
import type { ReadonlyJsonValue } from "../json"
import { UniqueValueViolationError } from "../materialization/errors"

/**
 * The coded error a write reports when it would give a unique value to a second object, or
 * `undefined` for any other error. Like its message, it names only the type and the property:
 * never the value, nor the object that holds it.
 */
export function uniqueViolationError(
  error: unknown,
  details?: ReadonlyJsonValue
): SixbCodedError | undefined {
  if (!(error instanceof UniqueValueViolationError)) return undefined

  return codedUniqueViolation(error, {
    cause: error,
    details: details ?? { objectTypeId: error.objectTypeId, propertyId: error.propertyId },
  })
}

/** The same coded error for a batch item that a continue-mode commit refused. */
export function uniqueViolationItemError(item: UniqueViolation): SixbCodedError {
  return codedUniqueViolation(item, {
    details: { objectTypeId: item.objectTypeId, propertyId: item.propertyId },
  })
}

interface UniqueViolation {
  readonly objectTypeId: string
  readonly propertyId: string
  readonly message: string
}

function codedUniqueViolation(
  violation: UniqueViolation,
  options: SixbErrorOptions
): SixbCodedError {
  const coded = createSixbError("object.unique_violation", violation.message, options)

  return withFailureMessage(
    coded,
    `Property '${violation.objectTypeId}.${violation.propertyId}' is unique.`
  )
}
