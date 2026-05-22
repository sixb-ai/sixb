/**
 * Thrown when a storage lookup by primary ID finds no matching object.
 * Carries structured context so callers can discriminate without string parsing.
 */
export class ObjectNotFoundError extends Error {
  readonly name = "ObjectNotFoundError"

  constructor(
    readonly objectTypeId: string,
    readonly primaryId: string,
    readonly context: string
  ) {
    super(`[Pario] ${context}: ${objectTypeId}:${primaryId}`)
  }
}
