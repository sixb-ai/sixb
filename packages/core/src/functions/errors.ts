/**
 * Base error for the functions module. `FunctionValidationError` extends
 * this so callers can catch any function-scoped failure with a single
 * `instanceof FunctionError` check.
 */
export class FunctionError extends Error {
  readonly name: string = "FunctionError"
}

export class FunctionValidationError extends FunctionError {
  override readonly name = "FunctionValidationError"
}
