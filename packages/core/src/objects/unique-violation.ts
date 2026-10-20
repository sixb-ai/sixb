import { createSixbError, type SixbCodedError, withFailureMessage } from "../errors/internal"
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

  const coded = createSixbError("object.unique_violation", error.message, {
    cause: error,
    details: details ?? { objectTypeId: error.objectTypeId, propertyId: error.propertyId },
  })
  return withFailureMessage(
    coded,
    `Property '${error.objectTypeId}.${error.propertyId}' is unique.`
  )
}
