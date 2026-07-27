/**
 * Thrown when input violates an ontology constraint
 * (unknown property, missing required, invalid value, invalid target type, etc.).
 */
export class OntologyValidationError extends Error {
  // Widened from the literal so subclasses (notably MaterializationValidationError) can name
  // themselves while still being caught by `instanceof OntologyValidationError`.
  readonly name: string = "OntologyValidationError"
}

export function formatUnknownObjectTypeMessage(objectTypeId: string): string {
  return `Unknown object type '${objectTypeId}'. Object type IDs are case-sensitive.`
}
