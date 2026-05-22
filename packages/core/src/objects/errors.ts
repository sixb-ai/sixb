/**
 * Error for runtime invariants and failures specific to the objects module
 * (e.g., unexpected event results after appending an object/link event).
 */
export class ObjectError extends Error {
  readonly name = "ObjectError"
}
