import type { AiModelCallRecorder } from "@sixb/core/internal/model-execution"
import { QueueDeliveryLeaseLostError } from "@sixb/core/internal/workers"
import type { AgentRunRecord } from "@sixb/core/storage"
import { AgentTurnTimeoutError } from "./errors"
import type { AgentTurnContext } from "./types"

export interface AgentTurnRuntime {
  /** Worker shutdown, queue-lease loss, and user cancellation before the turn deadline is added. */
  readonly sourceSignal: AbortSignal
  /** Complete run signal, including the one wall-clock deadline shared by preflight and generation. */
  readonly signal: AbortSignal
  /** When `signal` times out. */
  readonly deadline: Date
  readonly usageRecorder: AiModelCallRecorder
  readonly timedOut: () => boolean
  /** Surface ownership, accounting, timeout, or cancellation before another durable action. */
  readonly assertCanContinue: () => void
  /** End the run: aborts `signal`, so a tool call that outlived it stops calling models. */
  dispose(): void
}

/** Start the run-owned accounting and wall-clock boundary before any optional compaction work. */
export function createAgentTurnRuntime(input: {
  readonly context: Pick<AgentTurnContext, "turnTimeoutMs">
  readonly run: AgentRunRecord
  readonly signal: AbortSignal
  /** The run session's, which admits, records and recovers each call. */
  readonly modelCalls: AiModelCallRecorder
  /** A child's: its parent's. The run times out there if its own budget from now ends later. */
  readonly deadline?: Date
}): AgentTurnRuntime {
  const usageRecorder = input.modelCalls
  const timeout = new AbortController()
  const ended = new AbortController()
  let timedOut = false

  const remainingMs = (input.deadline?.getTime() ?? Number.POSITIVE_INFINITY) - Date.now()
  const timeoutMs = Math.max(0, Math.min(input.context.turnTimeoutMs, remainingMs))
  const deadline = new Date(Date.now() + timeoutMs)
  const timer = setTimeout(() => {
    timedOut = true
    timeout.abort()
  }, timeoutMs)

  return {
    sourceSignal: input.signal,
    signal: AbortSignal.any([input.signal, timeout.signal, ended.signal]),
    deadline,
    usageRecorder,
    timedOut: () => timedOut,
    assertCanContinue() {
      if (input.signal.reason instanceof QueueDeliveryLeaseLostError) {
        throw input.signal.reason
      }
      usageRecorder.assertHealthy()
      if (timedOut) {
        throw new AgentTurnTimeoutError(input.run.id, timeoutMs)
      }
      input.signal.throwIfAborted()
    },
    dispose() {
      clearTimeout(timer)
      ended.abort(new DOMException("The Agent run has ended.", "AbortError"))
    },
  }
}
