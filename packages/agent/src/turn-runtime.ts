import type { AiModelCallRecorder } from "@sixb/core/internal/model-execution"
import { throwIfExecutionLost } from "./errors"

export interface AgentTurnRuntime {
  /** Worker shutdown, queue-lease loss, and user cancellation. */
  readonly sourceSignal: AbortSignal
  /** The run's signal: `sourceSignal`, and the run's end. */
  readonly signal: AbortSignal
  readonly usageRecorder: AiModelCallRecorder
  /** Surface ownership, accounting, or cancellation before another durable action. */
  readonly assertCanContinue: () => void
  /** End the run: aborts `signal`, so a tool call that outlived it stops calling models. */
  dispose(): void
}

/**
 * Start the run-owned accounting before any optional compaction work. A run has no time or step
 * limit: it ends when the model answers, when it is cancelled, or when its runner loses it.
 */
export function createAgentTurnRuntime(input: {
  readonly signal: AbortSignal
  /** The run session's, which admits, records and recovers each call. */
  readonly modelCalls: AiModelCallRecorder
}): AgentTurnRuntime {
  const usageRecorder = input.modelCalls
  const ended = new AbortController()

  return {
    sourceSignal: input.signal,
    signal: AbortSignal.any([input.signal, ended.signal]),
    usageRecorder,
    assertCanContinue() {
      throwIfExecutionLost(input.signal)
      usageRecorder.assertHealthy()
      input.signal.throwIfAborted()
    },
    dispose() {
      ended.abort(new DOMException("The Agent run has ended.", "AbortError"))
    },
  }
}
