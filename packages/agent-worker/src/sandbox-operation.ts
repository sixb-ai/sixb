import { createSixbError } from "@sixb/core/internal/errors"

/** How long the worker waits for one provider operation whose outcome it must confirm. */
export const SANDBOX_OPERATION_TIMEOUT_MS = 120_000

export function sandboxError(message: string): Error {
  return createSixbError("agent.execution_failed", `[SixbAgentWorker] Sandbox ${message}`)
}

/** Stop waiting for a provider operation that does not settle; its outcome stays uncertain. */
export function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(sandboxError("operation timed out; its outcome is uncertain.")),
        SANDBOX_OPERATION_TIMEOUT_MS
      )
    }),
  ]).finally(() => clearTimeout(timer))
}
