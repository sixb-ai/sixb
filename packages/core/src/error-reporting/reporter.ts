import type { SixbFailure } from "../errors"
import type { SixbErrorContext, SixbErrorHandler } from "./types"

const DEFAULT_FLUSH_TIMEOUT_MS = 5_000

/** Failure-isolated, non-blocking adapter around the configured callback. */
export class SixbErrorReporter {
  private readonly pending = new Set<Promise<void>>()
  private readonly handler: SixbErrorHandler

  constructor(handler?: SixbErrorHandler) {
    this.handler = handler ?? printFailure
  }

  /**
   * `failure` is handed in rather than derived from `cause`, and that is the whole point: the record
   * a handler receives has to be the record that was written. A caller that built one — every failed
   * run does, under the primitive's own code and with its typed extension — passes it; a caller with
   * no record builds one from the thrown value and says which code stands in for an unlabeled throw.
   */
  report(failure: SixbFailure, cause: unknown, context: SixbErrorContext): void {
    const invocation = Promise.resolve()
      .then(() => this.handler(failure, { ...context, cause }))
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

/**
 * What a runtime with no `onError` does with a failure.
 *
 * Not silence, because the project that has not configured reporting yet is exactly the one that
 * needs to see its dispatcher failing. Every escalation used to print at its own call site in its
 * own wording; this is the one line all of them print now, and setting `onError` replaces it rather
 * than adding to it.
 *
 * The thrown value goes through as the second argument so the runtime renders its stack, which is
 * the part a message cannot carry.
 */
function printFailure(failure: SixbFailure, context: SixbErrorContext & { cause: unknown }): void {
  try {
    console.error(
      `[Sixb] ${describe(context)} — ${failure.code}: ${failure.message}`,
      context.cause
    )
  } catch {
    // A replaced `console` must not turn a reported failure into an unhandled rejection.
  }
}

/** Where the failure happened, in the terms an operator uses for that part of the runtime. */
function describe(context: SixbErrorContext): string {
  switch (context.type) {
    case "run.failed":
      return `${context.run.kind} run '${context.run.runId}' failed`
    case "event.delivery.failed":
      return context.source
        ? `[${context.source}] event delivery failed (${context.eventTypes.join(", ")})`
        : `event delivery failed (${context.eventTypes.join(", ")})`
    case "rule.evaluation.failed": {
      const subject = context.subject
        ? ` on ${context.subject.objectTypeId}:${context.subject.primaryId}`
        : ""
      const rule = context.ruleId ? `rule '${context.ruleId}'${subject}` : "rule"
      return `${rule} evaluation failed (${context.source})`
    }
    case "background.task.failed":
      return context.subject
        ? `background task '${context.task}' failed on '${context.subject}'`
        : `background task '${context.task}' failed`
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
