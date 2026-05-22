/**
 * Thrown by worker primitives when an operation is interrupted by `stop()`.
 *
 * `name` is `"AbortError"` so it interoperates with the DOM `AbortSignal`
 * convention used across the codebase.
 */
export class WorkerAbortError extends Error {
  readonly name = "AbortError"
}
