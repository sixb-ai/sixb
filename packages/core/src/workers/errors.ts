import { SixbError, type SixbErrorCode, type SixbErrorOptions } from "../errors"

export interface WorkerAbortErrorOptions extends SixbErrorOptions {
  /** Subclasses narrow the failure; direct callers of `WorkerAbortError` leave this alone. */
  readonly code?: SixbErrorCode
}

/**
 * Thrown by worker primitives when an operation is interrupted by `stop()`.
 *
 * `name` is `"AbortError"` so it interoperates with the DOM `AbortSignal`
 * convention used across the codebase.
 */
export class WorkerAbortError extends SixbError {
  override readonly name: string = "AbortError"

  constructor(message?: string, options: WorkerAbortErrorOptions = {}) {
    super(options.code ?? "runtime.cancelled", message ?? "", options)
  }
}

/** Raised after a worker exhausts its bounded restart budget. */
export class WorkerUnhealthyError extends SixbError {
  override readonly name = "WorkerUnhealthyError"

  constructor(
    readonly workerName: string,
    readonly restartCount: number,
    options: SixbErrorOptions = {}
  ) {
    super(
      "runtime.unexpected",
      `[SixbWorker] ${workerName} is unhealthy after ${restartCount} restart attempt(s).`,
      { ...options, details: { workerName, restartCount, ...options.details } }
    )
  }
}
