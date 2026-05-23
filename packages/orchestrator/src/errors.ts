export class OrchestratorError extends Error {
  readonly name = "OrchestratorError"
  constructor(message: string, options?: ErrorOptions) {
    super(`[SixbOrchestrator] ${message}`, options)
  }
}
