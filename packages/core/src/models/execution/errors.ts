import { isSixbError } from "../../errors/internal"

/** A provider call was not recorded synchronously, so its execution must stop. */
export class ModelUsageRecordingError extends Error {
  readonly name = "ModelUsageRecordingError"

  constructor(
    readonly executionId: string,
    readonly callId: string,
    readonly recoveryScheduled: boolean,
    options?: ErrorOptions
  ) {
    super(
      recoveryScheduled
        ? `[SixbModels] AI usage for call '${callId}' in execution '${executionId}' was deferred to durable recovery.`
        : `[SixbModels] Could not preserve AI usage for call '${callId}' in execution '${executionId}'.`,
      options
    )
  }
}

/**
 * A model call refused or left unrecorded by the run's accounting: its AI limits refused it, or its
 * record could not be written. The run ends with this failure, never one that relabels it.
 */
export function isModelCallAccountingFailure(error: unknown): boolean {
  return (
    error instanceof ModelUsageRecordingError ||
    (isSixbError(error) &&
      (error.code === "ai.usage_limit_exceeded" || error.code === "ai.usage_limit_unavailable"))
  )
}
