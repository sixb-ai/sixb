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
