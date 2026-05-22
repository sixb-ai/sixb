/**
 * Base error for the rules module. `RuleValidationError` covers invalid rule
 * definitions both at builder time and during runtime startup validation.
 */
export class RuleError extends Error {
  readonly name: string = "RuleError"
}

export class RuleValidationError extends RuleError {
  override readonly name = "RuleValidationError"
}
