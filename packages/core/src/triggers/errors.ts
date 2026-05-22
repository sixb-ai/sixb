export class TriggerValidationError extends Error {
  override name = "TriggerValidationError"

  constructor(message: string) {
    super(`[Pario] ${message}`)
  }
}
