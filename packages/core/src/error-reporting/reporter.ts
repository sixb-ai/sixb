import { normalizeReportedError } from "./normalize"
import type { SixbErrorContext, SixbErrorHandler } from "./types"

const DEFAULT_FLUSH_TIMEOUT_MS = 5_000

export interface ErrorReporter {
  report(error: unknown, context: SixbErrorContext): void
}

/** Failure-isolated, non-blocking adapter around the configured callback. */
export class SixbErrorReporter implements ErrorReporter {
  private readonly pending = new Set<Promise<void>>()

  constructor(private readonly handler?: SixbErrorHandler) {}

  report(error: unknown, context: SixbErrorContext): void {
    const normalizedError = normalizeReportedError(error)
    if (!this.handler) {
      reportToConsole(normalizedError, context)
      return
    }

    const invocation = Promise.resolve()
      .then(() => this.handler?.(normalizedError, context))
      .then(() => undefined)
      .catch((handlerError) => {
        try {
          console.error("[Sixb] onError handler failed:", handlerError)
        } catch {
          // Error reporting must never escape back into framework execution.
        }
      })

    const tracked = invocation.finally(() => {
      this.pending.delete(tracked)
    })
    this.pending.add(tracked)
  }

  async flush(timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS): Promise<void> {
    const deadline = Date.now() + Math.max(0, timeoutMs)
    while (this.pending.size > 0) {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0 || !(await settleWithin([...this.pending], remainingMs))) {
        try {
          console.error(
            `[Sixb] Timed out after ${timeoutMs}ms waiting for ${this.pending.size} onError handler(s).`
          )
        } catch {
          // Error reporting must never escape back into framework shutdown.
        }
        return
      }
    }
  }
}

function reportToConsole(error: Error, context: SixbErrorContext): void {
  try {
    console.error(`[Sixb] Unhandled ${context.type}:`, error, context)
  } catch {
    // Error reporting must never escape back into framework execution.
  }
}

async function settleWithin(
  promises: readonly Promise<void>[],
  timeoutMs: number
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.allSettled(promises).then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
