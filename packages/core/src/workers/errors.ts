/**
 * Thrown by worker primitives when an operation is interrupted by `stop()`.
 *
 * `name` is `"AbortError"` so it interoperates with the DOM `AbortSignal`
 * convention used across the codebase.
 */
export class WorkerAbortError extends Error {
  readonly name = "AbortError"
}

/** Raised after a worker exhausts its bounded restart budget. */
export class WorkerUnhealthyError extends Error {
  readonly name = "WorkerUnhealthyError"

  constructor(
    readonly workerName: string,
    readonly restartCount: number,
    options?: ErrorOptions
  ) {
    super(
      `[SixbWorker] ${workerName} is unhealthy after ${restartCount} restart attempt(s).`,
      options
    )
  }
}
