export type AiCostStorageErrorCode = "missing_usage" | "cost_mismatch"

export class AiCostStorageError extends Error {
  readonly name = "AiCostStorageError"

  constructor(
    readonly code: AiCostStorageErrorCode,
    message: string
  ) {
    super(message)
  }
}
