/**
 * Thrown when input violates an ontology constraint
 * (unknown property, missing required, invalid value, invalid target type, etc.).
 */
export class OntologyValidationError extends Error {
  // Widened from the literal so subclasses (notably MaterializationValidationError) can name
  // themselves while still being caught by `instanceof OntologyValidationError`.
  readonly name: string = "OntologyValidationError"
}

/**
 * The caller named a definition the ontology does not register — an object type, a link.
 *
 * A subclass rather than a sibling, so every `instanceof OntologyValidationError` still catches it.
 * The distinction it adds is *missing resource* versus *invalid input*: both are the caller's
 * mistake, but only one of them is answered with a 404. Everything else `OntologyValidationError`
 * covers — unknown property, missing required, bad value, wrong target type — is a 400.
 */
export class OntologyNotFoundError extends OntologyValidationError {
  readonly name: string = "OntologyNotFoundError"
}

export function formatUnknownObjectTypeMessage(objectTypeId: string): string {
  return `Unknown object type '${objectTypeId}'. Object type IDs are case-sensitive.`
}
