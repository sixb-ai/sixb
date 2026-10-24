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

  return codedViolation(error.objectTypeId, error.propertyId, error.message, {
    cause: error,
    details,
  })
}

/** The same coded error for a batch item that a continue-mode commit refused. */
export function uniqueViolationItemError(item: UniqueViolation): SixbCodedError {
  return codedViolation(item.objectTypeId, item.propertyId, item.message)
}

interface UniqueViolation {
  readonly objectTypeId: string
  readonly propertyId: string
  readonly message: string
}

/**
 * The error a create meets on a primary id an object its writer cannot see holds. It tells that the
 * id is taken, as a unique value is, and nothing about the object.
 */
export function primaryIdTakenError(
  objectTypeId: string,
  primaryPropertyId: string
): SixbCodedError {
  return codedViolation(
    objectTypeId,
    primaryPropertyId,
    `[Sixb] Another '${objectTypeId}' object already has this '${primaryPropertyId}'.`
  )
}

function codedViolation(
  objectTypeId: string,
  propertyId: string,
  message: string,
  options: { readonly cause?: unknown; readonly details?: ReadonlyJsonValue } = {}
): SixbCodedError {
  const coded = createSixbError("object.unique_violation", message, {
    ...(options.cause === undefined ? {} : { cause: options.cause }),
    details: options.details ?? { objectTypeId, propertyId },
  })
  return withFailureMessage(coded, `Property '${objectTypeId}.${propertyId}' is unique.`)
}
