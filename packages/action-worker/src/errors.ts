export class ActionWorkerError extends Error {
  readonly name = "ActionWorkerError"
  constructor(message: string, options?: ErrorOptions) {
    super(`[SixbActionWorker] ${message}`, options)
  }
}
