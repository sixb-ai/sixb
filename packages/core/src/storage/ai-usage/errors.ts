export type AiUsageStorageErrorCode = "duplicate_id" | "missing_execution"

/** Storage failure specific to the AI model-call usage ledger. */
export class AiUsageStorageError extends Error {
  readonly name = "AiUsageStorageError"

  constructor(
    readonly code: AiUsageStorageErrorCode,
    message: string
  ) {
    super(message)
  }
}
