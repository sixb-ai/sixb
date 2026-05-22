/**
 * Thrown when input violates an ontology constraint
 * (unknown property, missing required, invalid value, invalid target type, etc.).
 */
export class OntologyValidationError extends Error {
  readonly name = "OntologyValidationError"
}
